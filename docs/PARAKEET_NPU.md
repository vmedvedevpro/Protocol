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
| Live: the VAD's cap flag and the worker's windows | `audio/vad.rs`, `audio/pipeline.rs`, `audio/recording_state.rs`, `audio/transcription/parakeet_live.rs`, `audio/transcription/worker.rs` |
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
- Either way a junction drops a call's word only when the other call has a
  word in its place: any word that starts within 320 ms of it, or whose tokens'
  frames overlap its own (a word split or joined differently, as when a window
  starts inside it). A word carries its first token's frame and the end of its
  last one's for that. So words in a span the other call left empty stay; a
  word the other call has some different word near still goes. An earlier
  call's word is weighed against the later call's kept words, a later call's
  against all of the earlier call's, so of two spellings of one word on either
  side of the middle the earlier one stays.
- Each word goes to the piece it starts in, so the rows stay the VAD's pieces.

**Why a junction keeps a word only one call heard.** TDT now and then emits
nothing for seconds of speech near a window's edge, and the retry does not
always help: on #66's QA meeting the window after "the budget, and the vendor
choice" decoded nothing for its first 3.4 s, its retry 0.5 s later too, and
two other windows decoded nothing for the last 2.5 s and the first 3.7 s. With
no word on that side of the overlap there was no anchor, and the middle gave
the span to the call that had heard nothing: "the vendor choice", "The
remaining" and "One risk" were lost although the neighbouring call had them.
`chunking.py` has the same rule and loses the same words wherever its decoder
skips (two of the three there; its ONNX Runtime encoder decoded the third).
`measure::npu::window_trace` prints every call's words and each junction's
choice on a recording, for such cases.

A stretch's audio is its pieces' samples end to end (gaps of up to 50 ms
filled with zeros); a retry that reaches before the stretch's start reads
silence there. The post-meeting pass frees the tracks once they are cut, so the
pieces are the audio it has.

The ignored `measure::npu::chunking_matches_feed_b` checks the port against
#80's recorded runs: the windows it plans (with the snap and the retries' layout)
are identical on all six kit files, and so are the texts its merge and assign
give from #80's decoded words, but for the words only the port keeps (above):
each piece's `chunking.py` text is its text with words left out (4, 33, 160,
92, 10 and 42 words on the six files; #80 recorded only each word's start, so
these include words the token frames would match).

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
with context on both sides. As at any junction, held words with no kept word
of that call in their place stay, and so do its words after the last shown one
with no word of the earlier calls in their place. Held words are shown with the
next piece's row.

The rest usually comes: after the cap cut the VAD keeps the speech and sends it
at its next pause (800 ms of redemption) or its next cap, also when the source
then goes silent (`finalize_inactive_speech`), so it reaches the worker within
about 6.8 s. It is lost when it is digital silence, under 800 samples, or the
capture restarts. Held words are then shown as a row of their own, with their
own time and the label of the piece they were held from, never at the start
of a later row (`audio/transcription/parakeet_live.rs`):

- before the source's next piece, when that piece does not continue the stretch;
- once their source's audio is `HELD_WAIT` (8 s) past them with no piece
  waiting for the worker, the stretch kept for a late continuation;
- at the end of the recording.

The wait is measured on the source's own audio (the end of its newest piece
received, plus the time since it was received; capture runs in real time, so
this is never ahead of the recording), not from when the worker got to the held
piece, and the deadline applies only to an empty queue
(`parakeet_live::next`): a worker that lags behind takes the queued
continuation first, and it joins the held words as it would on time.

Such rows get the glossary's spellings like every other row; a system-audio
source that has had no labelled row yet uses the worker's label for it
("Guest"), never the user's.

The worker owns one `Live` per capture source for the recording (`worker.rs`,
one worker). The cost: about 1.6 calls per piece instead of one, and up to one
second of words appearing with the next piece at a cap cut.

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

`active` is true while the loaded model encodes on the NPU. `reason` is
technical (it can name OpenVINO and the plugin) and only for logs: Settings
says in its own words that the NPU is off.

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
takes the NPU.

While a recording or another engine job runs (anything in the busy registry but
a download or onboarding), the preparation only waits: the busy check comes
before any native step, so it neither queries the NPU nor writes the crash
marker, and the device is asked once per process. A compile that started
before a recording runs to its end beside it: the C API cannot cut one call
short. A removal of v3 or the runtime while it compiles wins: the job drops
what it compiled and does not become `ready`. A load while `ready` checks that
the prepared key is still the installed encoder's and prepares again
otherwise, and a start without v3 removes a cache left behind. Measured on an Arc B390 laptop's NPU (driver 32.0.100.5540):
80-130 s of the driver compiler, 1.2 GB of cache, 1.5 s for a cached load.

**Use**: a Parakeet v3 load while `ready` compiles from the cache and checks
one inference (`state::encoder_for_load`), then `ParakeetModel::new_with_npu`
keeps the encoder without an ONNX Runtime encoder session. While the state is
`preparing` or `ready` the Labs DirectML switch no longer applies to the
encoder (`state::overrides_labs`); in every other state, `failed` included, it
applies as before.

**Fallback**: a failure of the load, the device query, the compile, the first
inference or any later inference records the reason (`failed`), and Parakeet
runs on the processor, or on DirectML at its next load when the Labs switch is
on; after a failed inference the loaded model builds its CPU encoder session
then and continues one call per piece. A failure is kept in the key folder, so
the NPU stays off at later starts until a retry or a new driver or runtime (a
new key); a single failed inference counts too. A failure while the app closes
is not kept.

**Crash guard** (`guard.rs`, the pattern of #82): the steps that can take the
process down (loading the C API, the device query, compiling, the first
inference) write `<data>/runtimes/parakeet-npu.attempt`; a marker found at the
next start keeps the NPU off (`failed`) until `parakeet_npu_retry`. The marker
is separate from Whisper's. A clean exit (`RunEvent::Exit`) or the updater's
close removes it at once, also in the middle of the first compile, and the steps
after it write none (`guard::set_closing`). An end without them (Windows
shutting down, power loss, a kill from Task Manager) during a step counts as a
crash, as a broken driver would.

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

**Who keeps the runtime**: on a PC with an Intel NPU, the runtime stays even
without a Whisper companion while Parakeet v3 is installed or its download runs
(`state::keeps_runtime`, `state::model_download`; at the startup prune, the
companion's removal and the companion status: installed, not "removed at
restart", and `removesRuntime` false). A runtime downloaded alone for a v3 that
never arrived (its download failed, was cancelled or the app quit first) is
pruned at the next start like any runtime no one needs, and the NPU reads
`needs_runtime` again. Removing v3 removes the NPU cache
(`state::model_removed`), and with no companion left the runtime goes at the
next start. Removing the last companion still removes Whisper's own cache.
Whisper's cache prune leaves the `parakeet-npu` folder alone.

## Tests

- Unit: `chunking` (words, stretches, the plan and its snap, the retry, the
  anchor merge, the words a junction keeps when the other call decoded none in
  their place, after a meeting and live, assign, the stretch audio, the live hold and its rules, flush
  and release, bounded live state), `parakeet_live` (the bounded wait, the row
  before an unrelated piece, the end of the recording and the labels),
  `post_meeting` (each piece's stretch found once), `npu::state` (states,
  serialization, the cache key, the keeper and its marker, a failure while
  closing), `npu::guard` (a crash, a clean quit in the middle of a compile),
  `npu::detect`, `runtime` (completion, its failure and cancel, another build),
  `openvino` (the runtime alone installed and completed under the busy
  registry, the status with the NPU's keeper), Whisper's cache prune sparing
  the NPU folder.
- Ignored, with fixtures under `.measure/` and an NPU: the parity test above,
  the in-process completion test, `npu_encoder_smoke` (NPU against the CPU
  encoder on the padded input), and `window_trace` (every call's words and each
  junction's choice on a recording, `MEASURE_AUDIO`, with `TRACE_CPU` the
  processor's piece-by-piece text beside each piece).
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
- A held word shows up with the next piece's row, up to a second late; when its
  continuation was lost, in a row of its own once the recording is 8 s past it.
- A word up to about 1.5 s before a cap cut can come out wrong and is shown
  before the next call hears it right: the hold covers the last second only.
- One word two windows timed more than 320 ms apart without overlapping token
  frames is two words to the rule and stays twice, for instance a one-token
  word that a window starting just before it times 340 ms late: a junction
  prefers a doubled word to a lost one. On the kit's six files the rule changed
  texts only by adding words, after a meeting and live; a few of them double
  their neighbour (live "And And" on `ami-es2004a-mix`, where two windows time
  that "And" 295 ms apart, is probably such a junction duplicate).
- A compile that started before a recording runs through it.
- A failed inference keeps the NPU off at later starts until a retry or a new
  driver or runtime.
