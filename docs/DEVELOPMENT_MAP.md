# Development map: how the recording and speaker paths connect

This is an orientation map for contributors and coding agents, not a substitute
for reading the owning code. The map describes this branch's implementation;
release availability and qualification are separate facts documented below.

## 1. Keep these three responsibilities separate

| Responsibility | Owner | Meaning |
| --- | --- | --- |
| Transcription | Parakeet, Whisper, or configured provider | Produces words and transcript timing. |
| Diarization | Selected Pyannote/WeSpeaker or Nemotron engine | Assigns meeting-local speaker labels to audio/transcript turns. |
| Capture provenance | Independent microphone/system tracks | Establishes the local `You` label; it is not inferred from speaker channel 0. |

Nemotron is diarization, not voice isolation. Its overlapping activity predictions
do not produce separate audio tracks for each remote voice. Names, voiceprints,
and a model's anonymous speaker channels are also different concepts.

## 2. Recording data flow

Speech-start pre-roll, live system speech sensitivity, and real-call replay
qualification are documented in [LIVE_SPEECH_RETENTION.md](LIVE_SPEECH_RETENTION.md).
Sample continuity across jittered capture callbacks and issue #40 qualification
are documented in [AUDIO_CALLBACK_CONTINUITY.md](AUDIO_CALLBACK_CONTINUITY.md).
That note also covers the Windows/shared-mixer and macOS follow-ups for #42:
Windows CPAL mic/system blocks and macOS CPAL mic blocks use bounded workers, with
capture timestamps, queued mute state, and stop/drain ordering owned by
`audio/stream.rs`, `audio/pipeline.rs`, and `audio/recording_manager.rs`.
CPAL capture age is converted to block-end recording seconds before processing.
The shared mixer uses its full 400 ms missing-source allowance and drains input
before enforcing further waiting; it no longer pops queued samples off the front.
Per-instance local logs count inserted silence and discarded late samples.
Timeline resets save both pending source tails before replacing the mixer origin.
Windows Stop gates new callbacks and bounds native cleanup to three seconds per
stream; new capture is blocked while timed-out cleanup still owns a native stream.
Twenty-two pipeline regressions passed on Windows, including ten-minute dual
source skew/stall replays, bounded missing-source output, and queued mute state.
The ignored `audio::pipeline::hardware_qualification` test opens explicitly named
Windows endpoints and exercises the production mic worker, dual VAD, mixer, and
native Stop without saving audio. See the continuity note for its opt-in command,
results, and limitations (especially silent microphones and omitted ASR).
The corrected 11-minute G733 capture-only soak passed with 35 ms native Stop and
all nonzero system samples preserved. The microphone supplied silence; speech
retention remains unqualified. The native suite passed 370 tests (ten opt-in tests
ignored normally), including 22 pipeline and eight worker regressions.
Published previews predate these corrections; see the linked continuity note
for verification and limits.
The #42 follow-up uses `audio/capture_worker.rs` for explicit close/drain and a
bounded wait independent of retained native callbacks. Its five std-only
regressions passed on synthetic inputs; physical Mac Stop, missing microphone
audio, and live-text gaps remain unqualified (see the linked continuity note).
`AudioMixerRingBuffer` also recovers a source clock left behind emitted silence
or a full-window callback loss, but only once fresh capture timestamps reach the
un-emitted timeline. Old queued frames still cannot overwrite saved silence.
All 17 native pipeline regressions passed on Windows. Mac candidate builds run
worker and source-continuity regressions before upload.
The separate macOS system tap in `audio/capture/core_audio.rs` now survives
ring-buffer pressure and closes its async wake registration race; neither path
has a physical macOS reproduction/qualification yet. Its aggregate device keeps
`tapautostart` off: with it on, the HAL ran no IO until something played, so a
meeting started in silence stopped after five seconds (issue #42; physical
reproduction and local fix check in [OCTOBER_PR_INTEGRATION.md](OCTOBER_PR_INTEGRATION.md)).
A later tap stall warns the user (`RecordingState::report_warning` →
`recording-audio-route-warning`) and keeps the microphone recording.
The home screen's macOS computer-audio banner (`hooks/usePermissionCheck.ts`,
`components/PermissionWarning.tsx`) reads Audio Capture authorization from TCC
through `get_system_audio_permission_status` in `audio/permissions.rs`. That uses
the private `TCCAccessPreflight`, resolved with `dlopen` at runtime, because Apple
has no public query and a tap returns zeros both when denied and in silence.
Granted means no banner, with no audible proof needed on each launch. Denied and
not-yet-asked get their own advice. TCC answers from a per-process cache: on
macOS 26.6.2 a grant from the prompt that "Check again" triggers kept reading
not-yet-asked in that process until restart (checked with an ad-hoc build).
Readable permission states are therefore asked again in a short-lived copy of the
app binary. `main.rs` handles `--audio-capture-status` by printing the code and
exiting before Tauri starts. Audible samples from the session-scoped probe also
clear the banner unless TCC explicitly denies access. If the symbol is missing,
the status is `unknown` and only the probe decides. Covered by
`tests/hooks/permission-check.test.tsx` and two native tests in `permissions.rs`;
the native check that the symbol resolves only runs on macOS.

October 22 follow-up: all readable TCC states, including granted, are rechecked
in the short-lived helper to avoid trusting a cached grant after revocation.
An explicit denial clears earlier session probe evidence; unknown status retains
the audible-probe fallback. Candidate CI tests the packaged helper with a timeout
and runs the full native library suite. See [MACOS_OCT22_STABILITY.md](MACOS_OCT22_STABILITY.md).
`frontend/src/app/layout.tsx` now loads packaged Inter font files from
`@fontsource-variable/inter` rather than fetching Google CSS during a Next
production build. `globals.css` owns `--font-sans`, and `frontend/pnpm-lock.yaml`
pins the bundled font package; this removes a network-dependent build step.

Meeting details layout lives in `frontend/src/app/meeting-details/page-content.tsx`:
the transcript/notes separator stores its width locally and supports pointer and
keyboard resizing. Pane stacking now responds to the actual content width (which
the sidebar can reduce), not just viewport width; this retains the minimum
transcript and notes widths from issue #25. The existing wrapped toolbars and
Export access remain in `components/meeting/MeetingHeader.tsx` and
`MeetingDocument.tsx`. Narrow-content browser checks are still required.

```text
recording_commands.rs: start command
  -> initialize selected live diarizer before capture (blocking work off Tokio)
  -> recording_manager.rs: devices + recording state + capture/pipeline
     -> pipeline.rs: align microphone and system audio into windows
        -> separate VAD processors for microphone and system
           -> vad.rs: resample to 16 kHz
              -> continuous observer BEFORE silence removal
                 -> system only: live_nemotron::feed(recording_sample, audio)
              -> VAD speech turns -> transcription queue
        -> persist mic/system source tracks and mixed playback audio
     -> transcription/worker.rs: transcribe each source's speech turn
        -> microphone: You
        -> Pyannote selected: online embedding/centroid speaker matching
        -> Nemotron selected: query streaming timeline by turn start + duration
        -> transcript-update event
           -> frontend TranscriptContext + live transcript view
           -> native recording transcript accumulator/save path
```

### Source files to read together

Paths below are relative to `frontend/src-tauri/src/` unless marked frontend.

| File | Owns / why it matters |
| --- | --- |
| `audio/recording_commands.rs` | Start/stop orchestration, selected-engine initialization, task lifetime, and transcript-update saving. Both recording start entry points need consistent behavior. |
| `audio/recording_manager.rs` | Starts capture and the audio pipeline, coordinates source state and recording storage. |
| `audio/pipeline.rs` | Alignment, independent source VAD, queueing completed turns, source/mixed track persistence, final audio drain. |
| `audio/vad.rs` | Resampling and VAD clocks. `process_audio_observed` supplies continuous 16 kHz audio before speech segmentation. |
| `audio/transcription/worker.rs` | ASR execution and the final speaker/source string carried by transcript updates. |
| `diarization/online.rs` | Selects the live engine at recording start; retains the existing Pyannote/WeSpeaker online clustering implementation. |
| `diarization/live_nemotron.rs` | Dedicated streaming inference thread, bounded queue, timestamped history, overlap lookup, error notification, and input-close/stop distinction. |
| `diarization/nemotron.rs` | Validates the pinned model and adapts the attributed Sortformer API to Meetily. Live configuration must not change offline defaults. |
| `diarization/sortformer/` | Attributed model implementation, including speaker cache, feed/flush, streaming profiles, and ORT session construction. Preserve license/attribution. |
| `audio/recording_saver.rs`, `audio/incremental_saver.rs` | Persistent transcript/source hints and recording tracks. A displayed rename alone does not update every save path. |
| `frontend/src/contexts/TranscriptContext.tsx` | Frontend transcript events, ordering/buffering, local recovery, and live state. |

### Time and identity invariants

- Capture/pipeline input is currently configured at 48 kHz. The streaming observer
  receives **16 kHz mono**, using the exact same resampled audio as VAD.
- Observer start positions and Sortformer segment boundaries use **16 kHz sample
  indices**. Transcript chunks carry recording-relative **seconds**. VAD speech
  boundaries expose **milliseconds**. Convert explicitly at boundaries.
- The observer position includes the VAD frame buffer, not just processed frames.
  Ignoring that buffer causes timestamp drift between diarization and transcripts.
- Preserve silence and timeline gaps. Concatenating VAD speech turns without
  their gaps is not a continuous recording and corrupts streaming timing.
- Mic and system audio must not be mixed before source attribution. Microphone
  audio retains `You`; remote model channels remain `Speaker N`.
- Speaker channels are meeting-local. The live model/cache is recreated for each
  recording. Changing settings during a call affects the next live session.
- One transcript turn currently gets one greatest-overlap label. Do not split
  text or fabricate word timestamps to represent within-turn speaker changes.

### Worker and shutdown ownership

The capture path only attempts a nonblocking send. A dedicated thread owns the
Nemotron model; ASR workers read its shared timeline rather than running model
inference on the capture/Tokio thread. The queue holds 600 50 ms windows. Full or
disconnected input reports an error and disables that session's labeling.

`finish()` closes streaming input after the pipeline has submitted its remaining
audio. The worker drains, flushes its final lookahead, and publishes a completion
watermark. **Do not destroy the timeline at this point**: final transcription
turns still need it. `stop()` releases the session after transcription processing
has been drained by recording-stop orchestration. Startup failures also clean up
the live session.

The low-latency profile buffers 1.04 s of audio, emits 0.72 s strides, and uses
0.32 s lookahead. These model parameters are not an end-to-end UI latency claim:
VAD boundaries, ASR time, and queue load also contribute. Timeline lookup waits
at most 1.5 s; history is limited to ten minutes. Missing/failed results retain
source labels rather than guessing a speaker or switching engines.

## 3. Post-call processing and model selection

Summary-generated title ownership, placeholder rejection and completion refresh
are documented in [SUMMARY_GENERATED_TITLES.md](SUMMARY_GENERATED_TITLES.md).

`diarization/mod.rs` owns persisted engine settings and offline command dispatch.
Nemotron is Auto-detect only; manual counts belong to Pyannote. Rerunning speaker
identification must preserve transcript text, row identity, and timestamps.
Read [PR34_NEMOTRON.md](PR34_NEMOTRON.md) before changing that contract.

Frontend post-call sequencing lives in
`frontend/src/components/MeetingDetails/PostCallProcessingWorker.tsx`, owned above
navigation by `frontend/src/contexts/PostCallJobsContext.tsx`. The page's
`PostCallProcessingDialog.tsx` registers/detaches only its view. Completion and
transcript refresh target the matching mounted meeting; inactive meetings refresh
on return. See [OCTOBER_PR_INTEGRATION.md](OCTOBER_PR_INTEGRATION.md) for cancellation
ownership and lifecycle limits. Related
speaker/retranscription dialogs. `useDiarizationEngine.ts` refreshes selected-engine
state for dialogs, including native activation events and stale-response guards.

Live ASR and post-call ASR defaults are independent. Optional Whisper activation
saves the **post-call** default; it must not replace the live Parakeet selection.

### Audio import and the recordings folder

`audio/import.rs` turns an external audio file into a new meeting:

```text
start_import_audio_command -> start_import (one import at a time, STT batch lease)
  -> run_import
     -> recording_preferences::configured_recordings_folder (Settings save_folder)
     -> create_import_meeting_folder: ensure_recordings_directory, then
        create_meeting_folder (collision-safe <title>_<timestamp>/)
     -> copy the source to <meeting folder>/audio.<ext>
     -> decode -> VAD -> Whisper/Parakeet with the saved glossary
     -> meetings row with folder_path, transcripts.json, metadata.json
```

Import writes to the recordings root a recording would use (#29; before that it
always used `get_default_recordings_folder()`). `configured_recordings_folder`
returns the saved `RecordingPreferences.save_folder`. The default root takes its
place when nothing is stored or the stored value no longer deserializes
(`preferences_from_store_value`), when preferences cannot be loaded (as at
recording start), and on macOS for a folder inside the app bundle
(`load_recording_preferences`). Before anything is written,
`ensure_recordings_directory` applies the Settings checks (app-bundle rejection
on macOS, create, probe write). An unusable saved folder fails the import with
its path in the error instead of writing to the default root, which would make
Settings look applied while files land elsewhere. The path appears once: it is
added only when the validation error does not already contain it. A failure in
`create_meeting_folder` after the checks pass (for example a name too long for a
deep folder) is a bare OS error, so the import adds the root path to it.

`diarization::find_meeting_audio`, the fallback when a meeting's `folder_path`
is missing or has no audio, searches the meeting folders of the configured root
and of the default root, where meetings recorded before a folder change remain.
`find_meeting_folder_audio` decides over both roots at once, so their order does
not matter:

1. A folder whose `metadata.json` `meeting_id` is the meeting's id is the
   meeting's (import writes the id). If that folder has no audio, nothing else
   in the roots is guessed.
2. Otherwise the candidates are folders with the meeting's title (sanitized,
   case-insensitive) and no other meeting's id: recordings, whose saver writes
   `meeting_id: null`, and old folders without metadata. The one whose start is
   closest to the meeting's `created_at` wins, within 12 hours.
   `created_at` is the recording start for meetings saved since v0.2.12 and the
   save time before that, hence the window.
3. Only folders named `<title>_<UTC start>[_<n>]` are considered, so albums and
   other folders in a broad root are ignored. The start is parsed in each format
   the app has written: `%Y-%m-%d_%H-%M-%S`, `%Y-%m-%d_%H-%M` and
   `%Y-%m-%d_%H-%M-%S-%3f`.

The install-local data root (tray saves) stays the last resort after the roots.
Limits: a folder without an id is not found once the meeting has been renamed,
and two same-title meetings without ids less than 12 hours apart resolve to the
closer start.

Retranscription and checkpoint recovery work inside an existing meeting folder
and create none. The other `get_default_recordings_folder()` callers are the
preference default, the fallbacks when preferences cannot be loaded, the
Settings default-folder display, and the short-take discard allow-list.

Native tests: `import_meeting_folder_is_created_in_custom_recordings_folder`,
`unusable_recordings_folder_fails_import_folder_creation`,
`unusable_recordings_folder_error_names_the_folder_once` and
`meeting_folder_creation_error_names_the_recordings_folder` (`import.rs`),
`stored_recordings_folder_is_loaded` and
`missing_or_unreadable_preferences_use_default_recordings_folder`
(`recording_preferences.rs`), and
`meeting_audio_lookup_prefers_the_folder_with_the_meeting_id`,
`meeting_audio_lookup_ignores_unrelated_folders_in_a_broad_root`,
`meeting_audio_lookup_finds_old_folder_without_metadata_by_start` and
`meeting_folder_names_parse_every_start_format` (`diarization/mod.rs`). The
lookup tests call `find_meeting_folder_audio` on temporary folders; the
`created_at` query in `diarize_meeting` is not tested. The store/`AppHandle` glue in
`configured_recordings_folder` has no test, and an import into a custom folder
has not been checked in the running app.

## 4. Optional download ownership and UI synchronization

### October integration interfaces

- `speakerUtils.ts` splits overlap labels for display and live aliases. Native
  `PeopleRepository` renames exact components transactionally; optional `from` on
  `reassign_transcript_speaker` selects one component without losing other voices.
  Speaker edits preserve transcript rows, text, timestamps, and source provenance.
  Coverage: `combined-speakers`, `combined-speaker-edit`, `live-speaker-edits`, and
  the native person-repository regressions.
- Markdown export uses `exportMarkdownFrontmatter.ts` and the current
  `useCopyOperations` hook. Named overlap components get separate optional links;
  generic labels do not become contacts. Other formats retain their old rendering.
- Vocabulary IPC names are now model-neutral (`api_get_vocabulary`,
  `api_save_global_vocabulary`, `api_save_meeting_vocabulary`). Existing vocabulary
  database tables remain. `parakeet_engine/model.rs` owns glossary token boosts and
  post-decode canonicalization; the seven synthetic regressions are not speech
  accuracy qualification. Import/live/post-call paths pass the saved glossary.
- Linux source builds map transcription `hipblas` to llama-helper `rocm` and
  resolve distro-specific SDK paths. Four ROCm parser regressions and normalized
  shell syntax checks ran; actual AMD build/inference did not.

See [OCTOBER_PR_INTEGRATION.md](OCTOBER_PR_INTEGRATION.md) for reviewed but blocked
PR #22/#38, qualification, and release status. These changes are source work;
published v0.2.20 installers do not contain them.

`frontend/src/contexts/OptionalModelDownloadsContext.tsx` owns optional jobs above
onboarding and Settings so normal navigation does not cancel them. This is not an
OS background service. An app exit and a WebView reload are different lifetimes.
The top-right `DownloadProgressToastProvider` consumes these same jobs alongside
Parakeet/summary transfers, including verification and activation progress; it
does not start downloads or duplicate optional completion notifications. See
`tests/download-progress/background.test.tsx` for the panel/provider integration.

For Nemotron, `download_diarization_models` in `diarization/mod.rs` performs the
verified download **and persists engine activation in native code**. On success
it emits `diarization-engine-changed`. This prevents page reloads from discarding
a required preference save in an abandoned JS completion callback.

The native event updates the optional-download card, Diarization Settings, and
open speaker dialogs. The frontend `optional-model-preferences-changed` DOM event
also refreshes preference views for frontend-triggered changes. These events are
different transports; neither is itself the persisted source of truth.

Read [NEMOTRON_NATIVE_ACTIVATION.md](NEMOTRON_NATIVE_ACTIVATION.md) for the regression
and installed-app test. Read [V0219_BACKGROUND_SETUP.md](V0219_BACKGROUND_SETUP.md)
and [V0220_OPTIONAL_ACTIVATION.md](V0220_OPTIONAL_ACTIVATION.md) as historical notes;
later fixes supersede earlier behavior. The post-v0.2.18 follow-up moves optional
Whisper activation into `whisper_download_model(enablePostCall=true)` and adds
native `uninstall_optional_model` ownership in `optional_models.rs`; see the
updated native-activation note for locking, settings events, tests, and limits.

## 5. Acceleration and packaging are separate from ASR selection

Windows Nemotron uses the pinned shared ONNX Runtime/DirectML integration, with
CPU-session recreation when provider initialization fails. It does not inherit
Whisper's CUDA/Vulkan/CPU backend selection. Read `onnx_runtime.rs`,
`frontend/src-tauri/build/onnxruntime.rs`, and the Sortformer session builder before
changing runtime loading or execution-provider settings.

Labs Parakeet GPU acceleration is a separate native preference in
`parakeet_engine/labs.rs`. It reloads the selected Parakeet model and places the
encoder session on DirectML device 0; the decoder and preprocessor remain on
CPU. Provider initialization errors are reported to Settings and the prior
preference/model is restored. This does not change Nemotron or Whisper's
backend. `get_local_stack_status` reports the native preference to the Local
stack UI; its previous Parakeet CPU pill was fixed text. An ignored test with
the installed v3 INT8 model and synthetic silence confirms encoder nodes run
on both DirectML and CPU; real speech performance remains unqualified.

The universal Windows build script is
`frontend/scripts/build-universal-windows.ps1`. It packages CPU/Vulkan/CUDA app
variants; the runtime payload must match the one validated in tests. Validate with
`node frontend/scripts/verify-windows-release.mjs`.
The packager no longer writes `latest.json` or updater signatures; the verifier
checks `SHA256SUMS.txt` (setup and engine), the NSIS archive, packaged variants,
and the bootstrapper payload.

### Fork identity and updates

Protocol is a fork of Meetily – Actually Free with its own identity, so it can run
beside an installed upstream build without sharing state:

| Surface | Value | Owner |
| --- | --- | --- |
| Bundle identifier, Windows AUMID | `io.github.vmedvedevpro.protocol` | `tauri.conf.json`, `notifications/native_windows.rs` |
| Product name, install folder | `Protocol`, `%LOCALAPPDATA%\vmedvedevpro\Protocol` | `tauri.conf.json`, `windows/installer.nsi`, `bootstrapper.cpp` |
| Installer registry key | `HKCU\Software\vmedvedevpro\Protocol` | `bundle.publisher` + product name; read by `bootstrapper.cpp` |
| Uninstall entry | `HKCU\…\Uninstall\io.github.vmedvedevpro.protocol` | `windows/installer.nsi` (`UNINSTKEY`) |
| Fallback data root | OS data dir `/vmedvedevpro/Protocol` | `paths.rs` (`FALLBACK_PUBLISHER`, `FALLBACK_APP_NAME`) |
| Default recordings folder | `protocol-recordings` | `audio/recording_preferences.rs` |
| Cargo package and executable | `protocol`, `protocol.exe`; installer variants `protocol-{cpu,vulkan,cuda}.exe`, `protocol-vulkan-probe.exe` | `src-tauri/Cargo.toml`, `build-universal-windows.ps1`, `windows/installer-hooks.nsh` |

The identifier also keys the single-instance lock, WebView storage, plugin
stores, and the legacy `app_data_dir` migration in `paths.rs`; under the old
identifier a first run would copy an installed upstream build's models and
database. Internal names stay upstream-compatible to keep merges cheap:
`MEETILY_*` environment variables and localStorage/event keys.

There is no in-app updater. `tauri-plugin-updater`, `tauri-plugin-process`,
`app_update.rs`, the update dialog/provider, the tray item, and the onboarding
consent step were removed; the CUDA launch notice that lived in the update
provider is now `components/CudaReconfigurationNotice.tsx`. After the change,
`next build`, `tsc --noEmit`, and 33 of 34 isolated frontend test files passed;
`tests/lib/meeting-titles.test.ts` fails on a Russian-locale Windows because it
expects English month names (unrelated to this change). Natively,
`cargo check --locked -p meetily --features vulkan --all-targets` and
`cargo test --locked -p meetily --lib --features vulkan -- --test-threads=1`
pass (379 passed; the 10 model/audio tests stay ignored). `Cargo.lock` was
regenerated by cargo and no longer carries the updater or its rustls/reqwest
0.12 stack. `bootstrapper.cpp` compiles with `/W4`, and the installer defines
(install folder, uninstall key, post-uninstall hook) were checked with makensis
3.11 on a stub script; the full universal installer, which needs the CUDA
toolkit, has not been built or installed.

There is no analytics code either (#14). The PostHog client was never created,
so the native `analytics` module with its 25 IPC commands, the `posthog-rs`
dependency, the meeting-end report in `stop_recording` (which read the model
settings only to send them), and the frontend `lib/analytics.ts` helper,
`AnalyticsProvider` and their call sites were removed without changing what
the app does. The `analytics.json` plugin store that earlier builds wrote
(meeting totals, the last meeting date, per-day meeting counts, and the opt-in
flags) stays in the plugin-store folder, `%APPDATA%\io.github.vmedvedevpro.protocol`
on Windows. It never left the machine and nothing reads or writes it; the app
does not delete it, and `PRIVACY_POLICY.md` tells users it can be deleted
safely. After the change,
`cargo check --locked -p meetily --features vulkan --all-targets` passes with
no new warnings, `cargo test -p meetily --lib --features vulkan -- --test-threads=1`
passes 377 tests (379 before, minus the two analytics property tests; 10 stay
ignored), and `next build`, `tsc --noEmit` and 33 of 34 isolated frontend test
files pass, with the same Russian-locale `meeting-titles` failure as above.

The Claude Code CLI summary provider was removed
([#19](https://github.com/vmedvedevpro/Protocol/issues/19)), so no IPC command
runs an executable chosen by the user any more. A settings row saved with it
still loads: `api.rs::read_model_config` returns any provider that
`LLMProvider::from_str` rejects as `provider: ''` and `model: ''` with no API
key, and `ConfigContext` keeps that instead of its Ollama default. Model Settings
then shows **Select provider** with Save disabled; Generate and Regenerate show
**Choose a summary provider** and open the meeting page's Model Settings dialog
(`openModelSettingsRef`, set by `MeetingDocument`). After a recording,
`keepsSavedSummaryModel` arms auto-summary for such a row; the refusal, like any
attempt that starts no run, disarms it, so re-renders and a provider selected but
not saved start nothing. A refused regeneration keeps its dialog and the Edited
state. Migration `20260914000000_add_claude_cli_path.sql` and the
`settings.claudeCliPath` column stay because sqlx refuses to start without an
applied migration; nothing reads or writes the column. The provider's working
folder `<data root>/claude-cli` is deleted at startup
(`paths::remove_claude_cli_working_dir`, best effort). Tests: native
`api::model_config_tests`, `live_assistant::assistant_model_tests` and
`paths::retired_dir_tests`; frontend
`tests/hooks/summary-provider-unavailable.test.tsx`,
`tests/meeting-details/summary-provider-prompt.test.tsx` and
`tests/lib/meeting-summary-policy.test.ts`. Details:
[ARCHITECTURE.md, Summary providers](../ARCHITECTURE.md#summary-providers).

The executable was renamed from upstream's `meetily.exe` to `protocol.exe`
(#12): the Cargo package and binary are `protocol`, and with no `mainBinaryName`
in `tauri.conf.json` Tauri takes the main binary name from Cargo, so
`tauri dev`, `tauri build` (`${MAINBINARYNAME}` in `installer.nsi`), and the
macOS `Contents/MacOS/protocol` follow it. Meeting detection
(`is_self_process`) and per-app capture treat `protocol` and `protocol-*` as
the app itself and Meetily as another app; the macOS console runs
`log stream --process protocol`. The uninstall hook stops only
`$INSTDIR\protocol.exe`, matched by image path; Tauri's `CheckIfAppIsRunning`
matched `protocol.exe` by name until the Tauri 2.12 update (#33), which made it
path-based through Restart Manager (see `ARCHITECTURE.md`, also for the
one-time upgrade from a pre-#12 install). Checks run for
the change: `cargo check --locked -p protocol --features vulkan --all-targets`;
`cargo test -p protocol --lib --features vulkan -- --test-threads=1` (379
passed, 10 ignored); makensis 3.11 on a stub that inserts every hook (only the
existing line-continuation warning); the hook's process stop run from a 32-bit
NSIS stub against 64-bit processes (only the copy under `$INSTDIR` stopped);
`bootstrapper.cpp` with `/W4`; and a debug, Vulkan, unsigned
`tauri build --bundles nsis` installed silently into a temp folder and
uninstalled, with stand-in processes: a running `meetily.exe` survived install
and uninstall, the installed `protocol.exe` was stopped, and a second
`protocol.exe` elsewhere was stopped by Tauri's check. The universal installer
(CUDA toolkit) and `verify-windows-release.mjs` (7-Zip, universal payload) were
not run. Before staging, `build-universal-windows.ps1` deletes the `*.exe` an
earlier build left in the gitignored `installer-variants` folder, so a
checkout's pre-rename `meetily-*.exe` are not signed and packaged; that cleanup
was tested on temporary folders, not in a full universal build.

## 6. Tests, qualification, and historical notes

macOS publication supports an explicitly labeled CI-qualified preview via
`publish-macos.yml` (`preview=true`). It records no physical-test attestation,
publishes a separate non-Latest prerelease, and retains artifact/hash/source
provenance and public launch checks. Stable publication still requires the
physical checklist. Documentation/publishing-only commits may follow a candidate;
application, dependency, and build-workflow changes require a new candidate.
See `.github/workflows/MACOS_RELEASE.md` for dispatch and remaining limitations.
The `v0.2.19-macos` preview packages the #42 callback change; build
`36790029640` and published-asset smoke test `36790877680` passed. It remains
unqualified for physical microphone capture and the reporter's device. The
Windows Latest release is now v0.2.20; see
[RELEASE_V0220_QUALIFICATION.md](RELEASE_V0220_QUALIFICATION.md) for Windows build,
hardware-capture, installed-upgrade, and public updater verification.
The `v0.2.20-macos` follow-up packages explicit worker shutdown and short-gap
source recovery for #42. Apple Silicon build `36876715270` passed all 22 worker
and pipeline regressions plus bundle/launch checks; public smoke test
`36878960910` passed. See [RELEASE_V0220_MACOS.md](RELEASE_V0220_MACOS.md) for
provenance. Physical recording and live-transcription confirmation remain open.
The Windows VirusTotal submission normalizes CRLF checksum manifests before
filename matching and Linux checksum verification.

Live system-meter warnings are documented in
[SYSTEM_AUDIO_LEVEL_ADVICE.md](SYSTEM_AUDIO_LEVEL_ADVICE.md).

See [PR39_INTEGRATION.md](PR39_INTEGRATION.md) for capture-readiness, setup
gating, quiet-speech and meeting-scoped speaker-edit recovery corrections.

### Home meeting library

`components/Sidebar/index.tsx` renders the text-only **Protocol** wordmark in
blue on one line. It opens About; the adjacent collapse control remains
separate. It replaced upstream's longer two-tone wordmark, which was checked at
the default 256px rail width; the shorter text has not been re-checked visually.

`frontend/src/app/home/page.tsx` renders the date-sorted meeting library and is
the Tauri startup route (`/home`). The recording-ready screen remains `/`; the
sidebar's New Recording action opens it. `SidebarProvider` owns the shared meeting
list and refresh/error state. `api_get_meetings` in `api/api.rs` batches saved
summaries and transcript labels, returning raw summary data, a plain-text preview,
and distinct custom speaker names in first-spoken order alongside date/duration.
Generated/source labels are excluded using `is_person_name`; these names are only
meeting display snapshots, not inferred cross-meeting identities. Home and meeting
details share the legacy/Markdown/BlockNote topic classifier in
`frontend/src/lib/summary-buckets.ts`. Home groups full-width meeting cards by
local date, connects each day's cards with a timeline, and filters title, named
participants, summary, and topics with the search field. Cards show a short
summary paragraph and at most three short Key Topics labels. Topic bullets with
label/explanation markup display only the label; the full summary is retained.
Missing summaries remain an explicit empty state. Cards link to the existing meeting detail route; Home
refreshes its list on entry after a summary is saved. `StartupTranscriptRecovery`
now mounts in the shared layout so IndexedDB recovery checks still run when Home
opens first. Tray/notification start events from Home route to `/` with the
auto-start flag for the recording hook. Topic extraction remains heuristic and
depends on a recognizable Key Topics heading or legacy section. Verification
covers frontend/native builds and the Windows installer payload; a local installer
is not a published release.

### Speaker colors in transcripts

`speakerUtils.ts` supplies the shared dot/text palette for the live and post-call
virtualized transcript, the live speakers list, the person card and the identify
dialog. The Tailwind scan must include `src/utils`, where the palette class names
are declared, or named speakers can render without a dot or text color in
production. A named person is drawn in their avatar's colour (`colorForName`),
so they look the same in the transcript, the meeting header and their contact
page; their transcript bubbles take a faint wash of it (`.af-speaker-bubble`).
Unnamed voices ("Speaker 2") get palette slots by first-spoken meeting order, so
they stay apart until identified; `You` uses the theme accent. The palette has
eight slots, so meetings with more than eight unnamed voices reuse colors.
The focused `tests/lib/speaker-colors.test.mjs` checks slot continuity and the
contact colour; the Next production CSS output must also contain every dot
palette class.

Labs roadmap features 1, 3, 7, 8, and 12 are mapped in
[LABS_MACWHISPER_FEATURES.md](LABS_MACWHISPER_FEATURES.md). Read it before
changing meeting detection, recorded audio seeking, named voice enrollment,
Whisper silence thresholds, or the clean transcript display. Settings > Labs
holds the switches (`LabsSettings.tsx`, `lib/labs-features.ts`); the Whisper,
voice-profile and Parakeet GPU switches also persist in native app data so they
survive a WebView reload. Each feature also appears where it is used: the
automation switch in Meeting detection, the waveform, slower speeds and
Clean/Verbatim switch in the meeting player, voices on each contact's page and
in the speaker card, and per-app capture (not a Labs feature) in Settings >
Recording and the record card's system audio panel. Named profiles use
WeSpeaker embeddings in Pyannote live sessions and as a separate identity
matcher for Nemotron live and both post-call paths. Nemotron remains the selected
diarizer; its channel numbers never establish persistent identity.

From `frontend/`, run all frontend test files in separate Bun processes. The
portable runner discovers `tests/**/*.test.{js,mjs,ts,tsx}` and fails if any file
fails. CI uses the same command, including optional-download, diarization, Labs,
and audio-level lifecycle tests. Isolation is required: summary-language tests
define a read-only `window`, while meeting-automation tests install their own
window; combining them in one Bun process caused repeated CI failures.

```text
pnpm dlx bun@1.3.10 scripts/test-isolated.mjs
pnpm run build
```

Native tests containing `live_nemotron` cover timeline attribution, retained tail,
history bounds, and the resampled observer clock. With the project's native build
prerequisites configured, use `cargo test -p protocol --lib live_nemotron` and the
appropriate platform feature flags. Windows qualification uses release binaries
and the packaged shared runtime; local `.build-tools/` scripts are environment-
specific conveniences, not substitutes for documenting prerequisites/results.

Ignored real-model tests require `MEETILY_NEMOTRON_MODEL` and
`MEETILY_NEMOTRON_WAV` (16 kHz WAV). The identity test optionally reads
`MEETILY_NEMOTRON_EXPECTED`, a JSON array of `{voice, start, end}` in seconds.
Run with `--ignored --nocapture --test-threads=1`; a normal unit-test pass does
not mean these model tests ran. Use nonprivate fixtures and report synthetic
throughput separately from real-call accuracy and concurrent-ASR performance.

Do not run Next builds concurrently with native commands embedding `frontend/out`
or with standalone TypeScript checking. When using pnpm in this environment,
`PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false` avoids the known store-layout issue.

| Note | Purpose |
| --- | --- |
| [LIVE_NEMOTRON_AND_PR36.md](LIVE_NEMOTRON_AND_PR36.md) | Live implementation, qualification, limitations, and assessed PR #36 scope. |
| [PR34_NEMOTRON.md](PR34_NEMOTRON.md) | Model provenance, hardening, DirectML qualification, and release numbering. |
| [V0218_DOWNLOAD_FIX.md](V0218_DOWNLOAD_FIX.md) | Async stack-overflow diagnosis; keep large checksum buffers off the future's inline stack. |
| [NEMOTRON_NATIVE_ACTIVATION.md](NEMOTRON_NATIVE_ACTIVATION.md) | Native download/activation lifetime regression and verification. |
| [UPSTREAM_0_4_1_PORTS.md](UPSTREAM_0_4_1_PORTS.md) | Selective upstream integration decisions. |

The public release documented in README is distinct from a local candidate.
Development labels 0.2.18–0.2.20 in historical notes were consolidated into the
0.2.17 candidate after checking GitHub's published 0.2.16. Re-check the actual
release state before future version work; do not treat this historical statement
as a permanently current release number.
