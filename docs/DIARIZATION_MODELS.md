# Pyannote/WeSpeaker model files

Issue #23 replaced the two ONNX files Protocol 0.3.0 bundled for the Pyannote
engine with public exports. This note records what ships, why, how it was
qualified against the 0.3.0 files, and what happens to a 0.3.0 install.

## What ships

`frontend/src-tauri/resources/diarization/`, pinned in
`model_integrity::PYANNOTE`, attributed in `THIRD_PARTY_MODELS.txt` there:

| File | Source (Hugging Face, pinned commit) | Bytes | SHA-256 | License |
| --- | --- | --- | --- | --- |
| `segmentation-3.0.onnx` | `onnx-community/pyannote-segmentation-3.0` @ `733a93b6473d019a773298e08cefa686894b1854`, `onnx/model.onnx` (float32) | 5 986 908 | `057ee564…1591ea25` | MIT (CNRS) |
| `voxceleb_resnet34_LM.onnx` | `Wespeaker/wespeaker-voxceleb-resnet34-LM` @ `f0c48c298fd835726c27956a5d617bad7115627e` | 26 530 309 | `7bb2f06e…2ec068` | CC BY 4.0 |
| `xvec_transform.npz` | `pyannote-community/speaker-diarization-community-1` @ `8a527374977391da736e0daaef26855d949d9685`, `plda/xvec_transform.npz` | 134 376 | `325f1ce8…cbe8f` | CC BY 4.0 |

Each file is byte-identical to its source; the Settings repair download takes
it from there and checks size and SHA-256. `bundled_pyannote_files_are_their_pinned_public_files`
hashes the bundled copies against the pins on every test run, and the ignored
`model_integrity::tests::pyannote_files_match_what_their_sources_serve` streams
the sources.

Until 0.3.0 the bundle held `segmentation-3.0-fp16.onnx` (2 977 738 bytes,
`b0acba8e…`) and `wespeaker-resnet34-LM.onnx` (26 544 003 bytes, `992a5632…`),
exports made by Meetily – Actually Free with no recorded procedure and no
public copy; the repair download served them from this repository at
`76e9939`. `xvec_transform.npz` is unchanged.

## Choice

Candidates (sizes and hashes in the issue #23 report):

| Candidate | Outcome |
| --- | --- |
| onnx-community segmentation-3.0 `onnx/model.onnx`, float32, opset 17 | **Chosen.** Matches PyTorch exactly (below); runs on ONNX Runtime 1.22–1.31. |
| same repository, `onnx/model_fp16.onnx` | Same size as 0.3.0, 99.8 % frame agreement with PyTorch, but crashes ONNX Runtime ≥ 1.23 at the app's optimization level. |
| `csukuangfj/sherpa-onnx-pyannote-segmentation-3-0` @ `9403a69` `model.onnx` | Numerically equal to the onnx-community float32 file (max difference 6e-5); not needed twice. |
| WeSpeaker's own `voxceleb_resnet34_LM.onnx`, opset 14 | **Chosen.** Same weights as the 0.3.0 file (all 67 large tensors within 1.9e-7 relative). |
| `onnx-community/wespeaker-voxceleb-resnet34-LM` `onnx/model.onnx` / `model_fp16.onnx` | The same export with renamed inputs; the float16 file does not load in ONNX Runtime 1.22. |
| sherpa-onnx release asset `wespeaker_en_voxceleb_resnet34_LM.onnx` | A GitHub release asset, not pinnable to a commit. |

The owner chose float32 segmentation (installer +3.0 MB) over float16 on
2026-10-26.

## Interfaces

| File | Input | Output |
| --- | --- | --- |
| 0.3.0 segmentation | `waveform` [1, 1, samples] | `segmentation` [1, frames, 7] |
| `segmentation-3.0.onnx` | `input_values` [batch, channels, samples] | `logits` [batch, frames, 7] |
| 0.3.0 WeSpeaker | `fbank` [batch, frames, 80] | `embedding` [batch, 256] |
| `voxceleb_resnet34_LM.onnx` | `feats` [B, T, 80] | `embs` [B, 256] |

All are float32 tensors; segmentation outputs log-softmax powerset scores (589
frames per 10 s window). `models.rs` reads the single input and output name of
each session and checks dtype, rank and the fixed dimensions, so a custom file
with another interface is refused at load (`a_model_with_another_interface_is_refused_at_load`).
The feature front-end (`dsp.rs`) is unchanged.

## Qualification

`diarization/qualification.rs`, ignored test `compare_model_sets`; how to run
it is in its module comment. Each compared folder holds the three files under
the current names, so the 0.3.0 files are compared renamed (the loader reads
their tensor names). All numbers below come from debug builds with ONNX
Runtime 1.22.0 on CPU, the app's runtime.

Fixtures, none committed and none private:

| Fixture | Source | License |
| --- | --- | --- |
| AMI test set, Mix-Headset (EN2002a–d, ES2004a–d, IS1009a–d, TS3003a–d; 9.1 h) | AMI corpus mirror; reference turns `only_words/rttms/test/<id>.rttm` from `pyannote/AMI-diarization-setup` @ `67c2d539286e89f68952d5dcf83912bd9f01dfae` | CC BY 4.0 |
| pyannote sample (30 s, 2 speakers) | `pyannote/pyannote-audio` @ `623ab14d69a039b474fc1fb2551b657aa00c0ce4`, `tutorials/assets/sample.{wav,rttm}` | MIT |
| tts-a (85 s), tts-b (70 s) | Windows text-to-speech voices Zira, David and Irina, turns concatenated with known gaps and 0.4 s overlaps | generated locally |

AMI speaker ids are participant ids, so the same person keeps the same id across
a meeting series; the voice-profile stage learns on some meetings and matches
on others.

### Segmentation against PyTorch

pyannote.audio 3.3.2 with the segmentation-3.0 PyTorch weights
(`csukuangfj/pyannote-models` @ `c720e69`, the public mirror sherpa-onnx exports
from), 242 windows of 10 s from five fixtures, ONNX Runtime at the app's Level3
optimization:

| Export | Frames with PyTorch's class | Max probability difference |
| --- | --- | --- |
| 0.3.0 float16 | 97.29 % | 0.97 |
| onnx-community float32 (bundled) | 100.00 % | < 0.0001 |
| onnx-community float16 | 99.81 % | 0.079 |

The 0.3.0 file computes its SincNet filters at run time in float16; the
onnx-community files store them precomputed. Speed is the same (about 40 ms per
10 s window on one CPU thread).

Both float16 files crash Python onnxruntime 1.23.2, 1.25.1 and 1.31.0 when
the session is built with `ORT_ENABLE_ALL`; the float32 file runs on 1.22.0 to
1.31.0. The app ships 1.22.0, so 0.3.0 was not affected, but an ONNX Runtime
upgrade would have been.

### Diarization error

Frame-based DER (10 ms frames, overlap scored, optimal speaker mapping), with
the default clustering threshold ("auto") and with the reference speaker count
("oracle"). 7 AMI meetings, the pyannote sample and both TTS fixtures, no
collar, time-weighted:

| Set | Auto | Oracle |
| --- | --- | --- |
| 0.3.0 files | 24.00 | 26.52 |
| float16 segmentation + WeSpeaker export | 24.15 | 19.91 |
| float32 segmentation + WeSpeaker export (bundled) | 24.41 | 19.89 |

Missed speech and false alarms agree within a few tenths of a point; the
differences are speaker confusion, i.e. clustering, which reacts strongly to
small changes in the turns it gets (ES2004b oracle 38.00 → 14.80, EN2002a
42.48 → 29.98, IS1009a 23.87 → 28.63).

### Live path, embeddings and voice profiles

- Live Pyannote assignment fed with the reference turns: identical labels for
  all sets on all ten fixtures (it uses only the embedding model).
- Embeddings of 616 clear turns (2–15 s, one speaker) across all 19 fixtures:
  cosine between the 0.3.0 and the bundled WeSpeaker file at least 1.000000 (six
  decimals).
- Voice profiles of 9 voices learned on tts-a, EN2002a, ES2004a, IS1009a and
  TS3003a and matched on everything else at the app's threshold 0.80 and margin
  0.08: identical counts whether the profiles were learned with the 0.3.0 file
  and matched with the new one, or both with the new one. Live matcher, per
  turn: 123 correct, 0 wrong, 284 unmatched; post-call matcher, per voice and
  meeting: 20 correct, 0 wrong, 13 unmatched.

## Voice profiles

Saved profiles and the local voiceprint are LDA-128 embeddings tagged with
`voice_profiles::MODEL` (`wespeaker-resnet34-LM/lda-128`), which names the
embedding space, not a file. Since the bundled export produces the same
embeddings, the id is unchanged and profiles need no migration or
re-enrolment. `qualification::bundled_embedding_model_keeps_the_voice_profile_space`
embeds a fixed synthetic voice with the bundled files and requires a cosine
above 0.9999 to the embedding the 0.3.0 file produced (0.99999977 today). A
future model that fails it needs a new `MODEL` id and a re-enrolment path.

## Upgrading a 0.3.0 install

- Bundled files: Windows installs (setup or the in-app updater, which runs the
  same NSIS installer) write the new files, and the `NSIS_HOOK_POSTINSTALL`
  hook (`Meetily_InstallCommonRuntime` in `windows/installer-hooks.nsh`) deletes
  `resources\diarization\segmentation-3.0-fp16.onnx` and
  `wespeaker-resnet34-LM.onnx`, which NSIS would otherwise keep and the new
  uninstaller would leave behind. macOS and Linux replace the whole bundle.
- User folder (`<data>/models/diarization/`): a 0.3.0 repair download left the
  three files there under the old names, and that folder wins over the bundle
  only when it holds all three current names, so those copies are never
  loaded. `diarization::retired::remove_retired_copies` runs at startup on a
  blocking thread and deletes an old-named file only when its size and SHA-256
  are the 0.3.0 file's, plus the `.part` of an interrupted 0.3.0 download.
  Another file under an old name is a custom model: it is kept, unused, and the
  log says to rename it. `xvec_transform.npz` there keeps its name and content.
- Custom models dropped into that folder must now use the new names; Settings
  shows them.

## Limits

- The upgrade path is covered by unit tests and code reading, not by running an
  installer over 0.3.0; that belongs to the QA step.
- Measurements ran on CPU with debug builds; DirectML inference of the new
  files was not measured.
- The clustering threshold was not re-tuned for the new segmentation.
- `dsp.rs` uses a Povey window where WeSpeaker and pyannote use Hamming; this
  predates the swap and is left alone, since changing it would move every saved
  voice profile.
- The PyTorch reference weights come from a public mirror; the gated
  `pyannote/segmentation-3.0` repository was not used.
