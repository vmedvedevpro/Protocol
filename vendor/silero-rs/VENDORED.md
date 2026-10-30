# Vendored silero-rs

This directory vendors [emotechlab/silero-rs](https://github.com/emotechlab/silero-rs)
(crate `silero`, MIT, `LICENSE` unchanged) so that Protocol's voice activity
detection can run on ort 2.0.0-rc.15 (#70). Protocol used it as a git dependency
at `26a6460` before.

## Provenance

- Upstream commit: `1283485dfd4ce6fda25248d52f6f68e27418d46c` (`main`, 2026-07-23).
- Vendored files: `LICENSE`, `README.md`, `src/lib.rs`, `src/errors.rs`.
  `Cargo.toml` is rewritten and `build.rs` is new; both are Protocol's.
- Left out: `models/silero_vad.onnx` (see below), `src/audio_resampler.rs`,
  `tests/`, `benches/`, `examples/`, `scripts/`, CI files and `CHANGELOG.md`.

Why vendored (checked 2026-10-30): upstream `main` pins `ort = "=2.0.0-rc.10"`
and `ndarray 0.16`. It bumped ort to rc.11 in January and reverted it a day
later (upstream #64). The open dependabot PR (upstream #84) moves the pin to
rc.13 without ndarray 0.17 and does not compile; nothing targets rc.14 or later.
ort rc.14 makes an explicit `Environment` mandatory for every session, which
changes this crate's public constructors, and ort-sys's `links = "onnxruntime"`
rules out a second ort version next to the app's.

## Model

`VadSession::new` embeds the Silero VAD v4 model. `build.rs` downloads it into
`OUT_DIR` and checks its size and SHA-256 before the build uses it, so the
binary is not in git:

- URL: `https://raw.githubusercontent.com/snakers4/silero-vad/915dd3d639b8333a52e001af095f87c5b7f1e0ac/files/silero_vad.onnx`
  (commit of the `v4.0` tag of [snakers4/silero-vad](https://github.com/snakers4/silero-vad), MIT, Silero Team)
- Size: 1,807,522 bytes; SHA-256 `a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28`
- It is byte-identical to `models/silero_vad.onnx` at both `26a6460` and
  `1283485` of silero-rs (same git blob `e6db48d6`), so the app embeds the same
  model as before.

## Changes to upstream's code

- ort 2.0.0-rc.15 and ndarray 0.17 (`Cargo.toml`).
- `VadSession::new`, `new_from_bytes` and `new_from_path` take the process's
  `&ort::environment::Environment` as their first argument (ort rc.14 allows one
  environment per process and the app owns it, `onnx_runtime.rs`).
- Sessions set ort's `AutoDevicePolicy::PreferCPU`. ort gives every new
  session builder the `MaxEfficiency` policy, under which ONNX Runtime 1.22 or
  later chooses the device for a session that registers no execution provider
  (ort's CPU provider registers none; it only switches the memory arena) and
  may put the model on an NPU or CoreML; Silero has always run on the CPU.
- Session construction moved into `build_session`, which returns `ort::Result`:
  ort's builder errors carry the (non-`Send`) builder, so `?` cannot convert
  them into `anyhow::Error` directly.
- The embedded model is read from `OUT_DIR` instead of `models/`.
- The `audio_resampler` feature and its rubato dependency are removed; Protocol
  resamples to 16 kHz before VAD (`audio/vad.rs`), and `validate_config` accepts
  only 8 and 16 kHz, as upstream does without that feature.
- Upstream's unit tests are removed: they read Git LFS audio and snapshot files
  that are not vendored. Protocol's VAD tests in `audio/vad.rs` and the ignored
  model tests exercise this crate.

## Behaviour against the previous pin `26a6460`

Upstream's commits since then that touch the code Protocol runs:

- `706be64`: the session uses one intra-op thread instead of four.
- `8f7cc8c`, `1283485`: fixes in `get_current_speech`, `trim_start_silence`,
  the speech start after deleted audio and the post-pad end. Protocol calls only
  `new`, `process`, `reset` and `session_audio_samples`, never deletes session
  audio, and keeps the post pad below the redemption time, so these paths do not
  change its segments.
- `9e5a6b9`: `reserve_audio_buffer` (unused by Protocol).

The measured comparison with the previous build is in #70's pull request.

## Updating

Re-apply the list above to a newer upstream revision, keep `LICENSE`, and
update the provenance here. If upstream moves to the ort version the app uses
and accepts an `Environment`, return to a git dependency and delete this
directory.
