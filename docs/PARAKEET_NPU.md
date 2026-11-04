# Parakeet on the Intel NPU

On Windows with an Intel NPU (Core Ultra), Parakeet v3's encoder runs on the
NPU through OpenVINO's C API from Intel's runtime, the one the catalog pins for
Whisper on the GPU (#66). Only the encoder moves: the `nemo128` preprocessor
and the decoder/joint stay on ONNX Runtime's CPU provider. The qualification
is #80 (device, shape, feeds, accuracy, speed and energy); this note is the
implementation.

## The pieces

| Part | Owner |
| --- | --- |
| C API binding (read the ONNX model, reshape, compile with properties, infer, tensors) | `parakeet_engine/npu/openvino.rs` |
| The encoder on the static shape | `parakeet_engine/npu/mod.rs` (`NpuEncoder`) |
| NPU present without the runtime (PnP) | `parakeet_engine/npu/detect.rs` |
| Crash guard of the native steps | `parakeet_engine/npu/guard.rs` |
| State, preparation, cache, commands, event, keeper | `parakeet_engine/npu/state.rs` |
| Windows of the static shape (feed B, live) | `parakeet_engine/chunking.rs` |
| Model with an NPU encoder, fallback | `parakeet_engine/model.rs` |
| Engine calls (`transcribe_audio`, `transcribe_pieces`, `transcribe_live`) | `parakeet_engine/parakeet_engine.rs` |
| Post-meeting pass on the NPU (import, retranscription) | `audio/post_meeting.rs` (`Pass::windows_over`) |
| Live: the VAD's cap flag and the worker's windows | `audio/vad.rs`, `audio/pipeline.rs`, `audio/recording_state.rs`, `audio/transcription/worker.rs` |
| Runtime pins, completion, the runtime alone | `model-catalog/catalog.json`, `model_catalog/runtime.rs`, `model_catalog/openvino.rs` |

## The static shape and why there are windows

The NPU compiles one input shape: 608 feature frames, 6.07 s of audio. A
shorter input is padded with zero features after its end and given its true
`length`; only `encoded_lengths` frames are decoded. #80 found that padding a
VAD piece costs words where the piece ends: the live VAD caps continuous speech
at 6 s and cuts at the quietest 50 ms of the last second, so the word there is
often cut, and the encoder then hears speech stopping dead against zeros.

So the NPU path never decodes piece by piece (`chunking.rs`, a port of #80's
`scripts/npu-bench/chunking.py`, its "feed B"):

- A *stretch* is one source's pieces touching within 50 ms. A stretch no longer
  than a window is one call.
- A longer one gets windows every 3.5 s, each after the first started at the
  quietest 20 ms within 0.5 s, the last one aligned to the stretch's end.
- A window of at least 4 s with fewer than 0.5 words per second runs again
  0.5 s later (earlier at the stretch's end); the call with more words stays.
- Neighbouring calls join on an anchor (the same word, at most 320 ms apart, the
  one nearest the middle of the overlap), else at the middle.
- Each word goes to the piece it starts in, so the rows stay the VAD's pieces.

A stretch's audio is its pieces' samples end to end (gaps of up to 50 ms
filled with zeros); a retry that reaches before the stretch's start reads
silence there. The post-meeting pass frees the tracks once they are cut, so the
pieces are the audio it has.

The ignored `measure::npu::chunking_matches_feed_b` checks the port against
#80's recorded runs: the windows it plans (with the snap and the retries' layout)
and the texts its merge and assign give from #80's decoded words are identical on
all six kit files.

### After a meeting

`Pass::windows_over` gives the pass all its pieces up front (import and
retranscription call it). When the loaded model encodes on the NPU, a piece's
whole stretch is decoded the first time one of its pieces comes, and the other
members' texts are kept for their turn. Skip rules, the silence-hallucination
filter and progress work per piece as before; the first piece of a stretch
carries the stretch's time. A single `transcribe_audio` call (the Tauri command,
or any caller with a longer clip) is decoded as one stretch.

### Live

Live pieces arrive one at a time and a row is final once shown. `chunking::Live`
computes the same windows as a source's stretch grows: at each piece, the
windows after the last one decoded, the last aligned to the piece's end. Words
already shown are never dropped (an anchor may not reach before the last shown
word; without one, new words start 200 ms after it). When the VAD cut the piece
at its cap (`SpeechSegment::capped`, carried by `AudioChunk::capped`), the
speech goes on and its rest comes as the next piece of the same source, so the
words of the piece's last second wait for that piece's call, which hears them
with context on both sides. If that call decodes nothing where the held words
are, they stay. The rest always comes: after the cap cut the VAD keeps the
speech and sends it at its end with the redemption tail, also when the source
then goes silent (`finalize_inactive_speech`). Held words are shown with the
next piece's row; a piece that does not continue the stretch (its rest was lost
as too short) first shows them; the end of the recording shows what is still
held as a last row of its source.

The worker owns one `Live` per capture source for the recording (`worker.rs`).
The cost: about 1.6 calls per piece instead of one, and up to one second of
words appearing with the next piece at a cap cut.

## States, preparation and use

The contract with Settings (#88) is `parakeet_npu_status`, `parakeet_npu_retry`
and the `parakeet-npu-status` event:

| State | When |
| --- | --- |
| `absent` | No Intel NPU (no present Intel device of the Neural processors setup class), or not Windows |
| `needs_runtime` | The runtime version in use lacks the NPU plugin or the ONNX frontend |
| `needs_model` | Parakeet v3 (`parakeet-tdt-0.6b-v3-int8`) is not installed |
| `waiting` | Due, postponed while a recording or another engine job runs |
| `preparing` | Compiling the encoder for the NPU; Parakeet runs on the processor |
| `ready` | Prepared; the encoder runs on the NPU from the next model load |
| `failed` | Preparation or a run failed, or a crash marker was found; `reason` says why |

`active` is true while the loaded model encodes on the NPU.

**Preparation** (`state::kick`, at startup and when the runtime, v3 or the
retry changes something): load OpenVINO's C API from the runtime folder the
process pins (`whisper_engine::openvino::pin_runtime`, so Whisper's GenAI later
loads the same version), ask the NPU plugin for `AVAILABLE_DEVICES`, the
driver's and the compiler's versions, and key the cache folder
`<data>/cache/openvino/parakeet-npu/<runtime>_<encoder sha256, 12>_<driver>_<compiler>/`.
A `prepared` marker there makes the state `ready` without compiling; a
`failed.txt` keeps the recorded failure. Otherwise, once nothing else runs,
compile with `NPU_COMPILER_TYPE=DRIVER` and `CACHE_DIR` holding
`BusyReason::ModelCompile`, run one inference of silence, write `prepared`,
remove the other keys, and unload the idle speech engines so the next load
takes the NPU. Measured on an Arc B390 laptop's NPU (driver 32.0.100.5540):
80-130 s of the driver compiler, 1.2 GB of cache, 1.5 s for a cached load.

**Use**: a Parakeet v3 load while `ready` compiles from the cache and checks
one inference (`state::encoder_for_load`), then `ParakeetModel::new_with_npu`
keeps the encoder without an ONNX Runtime encoder session. While the state is
`preparing` or `ready` the Labs DirectML switch no longer applies to the
encoder (`state::overrides_labs`).

**Fallback**: a failure of the load, the device query, the compile, the first
inference or any later inference records the reason (`failed`), and Parakeet
runs on the processor; after a failed inference the model builds its CPU
encoder session then and continues one call per piece. Nothing silently
switches to DirectML.

**Crash guard** (`guard.rs`, the pattern of #82): the steps that can take the
process down (loading the C API, the device query, compiling, the first
inference) write `<data>/runtimes/parakeet-npu.attempt`; a marker found at the
next start keeps the NPU off (`failed`) until `parakeet_npu_retry`. The marker
is separate from Whisper's, and a clean exit or the updater's restart removes it.

## The runtime

The catalog's runtime entry pins Intel's NPU plugin and the ONNX frontend beside
the files Whisper uses; both come from the same archive and are signed by Intel.
The plugin's own compiler (100 MB more) is not pinned: the NPU driver's compiler
compiles, which is why the compile sets the driver explicitly and an old driver
that cannot compile ends in `failed` with its reason.

An install made from an older catalog has the same version without the two
files. `runtime::complete_into` adds the files its record lacks (the archive is
fetched and checked as for an install, only the missing files are extracted
with their pins and signer and moved in, the record is rewritten last) without
touching the loaded ones, and `openvino_runtime_download` installs or completes
the runtime alone for a PC that does not take Whisper on the GPU. A fresh
`ov_core` after the completion finds both files in a running process (the
ignored `measure::npu::a_runtime_completed_while_loaded_runs_the_npu`), so no
restart is needed. 0.5.0 keeps an installed version as it is (it compares only
version and API level) and 0.4.3 does not read `runtimes`.

**Who keeps the runtime**: on a PC with an Intel NPU and Parakeet v3 installed,
the runtime stays even without a Whisper companion (`state::keeps_runtime`, at
the startup prune, the companion's removal and `removesRuntime`). Removing v3
removes the NPU cache (`state::model_removed`), and with no companion left the
runtime goes at the next start. Whisper's cache prune leaves the
`parakeet-npu` folder alone.

## Tests

- Unit: `chunking` (words, stretches, the plan and its snap, the retry, the
  anchor merge, assign, the stretch audio, the live hold and its rules, bounded
  live state), `npu::state` (states, serialization, the cache key), `npu::guard`,
  `npu::detect`, `runtime` (completion, its failure and cancel, another build),
  `openvino` (the runtime alone installed and completed under the busy registry),
  Whisper's cache prune sparing the NPU folder.
- Ignored, with fixtures under `.measure/` and an NPU: the parity test above,
  the in-process completion test, and `npu_encoder_smoke` (NPU against the CPU
  encoder on the padded input).
- The kit: `MEASURE_SETTINGS=parakeet` (post-meeting) and `parakeet-live`, with
  `MEASURE_PARAKEET_NPU` and `MEASURE_OPENVINO_RUNTIME`
  ([MEASURING_TRANSCRIPTION.md](MEASURING_TRANSCRIPTION.md)).

## Limits

- One runtime version per process: if the catalog brings a new version while
  the process uses an older one that lacks the NPU files, the NPU waits for the
  next start (`failed` with that reason).
- The NPU is found once per process; a driver installed while the app runs is
  seen at the next start.
- Only Parakeet v3 runs on the NPU; v2 stays on the processor.
- A held word shows up with the next piece's row, up to a second late.
