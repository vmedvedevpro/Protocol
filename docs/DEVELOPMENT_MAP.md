# Development map: how the recording and speaker paths connect

This is an orientation map for contributors and coding agents, not a substitute
for reading the owning code. The map describes this branch's implementation;
release availability and qualification are separate facts documented below.
Building from source, frontend checks, and syncing with upstream are in
[BUILDING.md](BUILDING.md).

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
Sample continuity across jittered capture callbacks and upstream issue #40 qualification
are documented in [AUDIO_CALLBACK_CONTINUITY.md](AUDIO_CALLBACK_CONTINUITY.md).
That note also covers the Windows/shared-mixer and macOS follow-ups for upstream #42:
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
The upstream #42 follow-up uses `audio/capture_worker.rs` for explicit close/drain and a
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
meeting started in silence stopped after five seconds (upstream issue #42; physical
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
transcript and notes widths from upstream issue #25. The existing wrapped toolbars and
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

### Stop, the meeting save, and quitting (#32)

Every Stop origin (window, tray, compact bar, quit) splits the work between
native code and the main window:

1. Native, `audio/recording_commands.rs::stop_recording_inner`: stops capture
   and flushes the pipeline, waits for every queued transcription chunk (at most
   10 minutes), unloads the speech model, finalizes `audio.mp4`, `mic.mp4` and
   `system.mp4` from their checkpoints and writes `transcripts.json` (at most
   5 minutes), clears `IS_RECORDING`, then sends `recording-stopped` and,
   to the main window only, `recording-stop-complete` with a `stop_id`.
2. WebView, `RecordingPostProcessingProvider` → `useRecordingStop`: discards a
   take under 10 seconds; otherwise waits 4.5 s for late transcript events,
   saves the meeting and transcript rows (`api_save_transcript`), files the
   meeting into a pending group, saves call notes and the summary language,
   clears the IndexedDB recovery record, and opens
   `/meeting-details?source=recording`, which starts post-call processing.
3. The WebView answers the Stop with `recording_save_finished(stopId,
   outcome)`: `saved`, `discarded`, `notSaved` or `failed`.
   `audio/save_handoff.rs` tracks the latest handoff from `begin` until that
   answer, for at most `ANSWER_WINDOW` (120 s); `updater::busy` reports it as
   `recordingSave`.

Before #32 a quit called `app.exit(0)` at once. It lost the audio since the last
30-second checkpoint, speech not yet transcribed, the finalized audio files and
the meeting row; the next start offered the meeting for recovery from IndexedDB
(only with at least one transcript line), with audio rebuilt from the
checkpoints.

`quit.rs` owns user quits: tray Quit, and on macOS ⌘Q and Dock Quit
(`RunEvent::ExitRequested { code: None }`, held back by `quit::holds_exit`).
`plan` reads recording state (running, stopping, or saving through the
handoff) and whether a downloaded update would install. With no recording work
the quit goes to `updater::quit_app` as before. Otherwise the main window leaves
compact mode and comes forward, and a native dialog (tauri-plugin-dialog, a
task dialog on Windows) asks "A recording is in progress. Stop and save it, then
quit?" with **Stop and quit** and **Cancel**. Stop and quit runs the tray's
native Stop unless a Stop already runs, waits for it and for the WebView's
answer, and calls `updater::quit_app` only after `saved` or `discarded`, so a
downloaded update installs only when nothing else is busy. While the quit
waits, the answer returns `true` and the WebView does not open the meeting, so
no post-call work starts that the exit would cut off. `failed`, `notSaved`, or
no answer within the window keep Protocol open with a message. A second quit
while the dialog is open or the meeting is being saved only brings the window
forward (`Flow`). A recording that meeting detection starts during the save
gets the question again.

Tests: `cargo test -p protocol --lib quit:: audio::save_handoff::
updater::busy::` (the decision matrix, the second quit, the macOS hold, which
answers let the app exit, handoff ids and the answer window) and
`frontend/tests/recording-stop/` (the answer for each ending, no meeting page
when quitting, the `stop_id` hand-over). Limits: Stop and quit does not run
speaker identification or the automatic summary; import, retranscription,
post-call processing and model downloads are not asked about and end with the
process as before (a summary cut off this way stays pending); Windows shutdown
and log-off exit without asking (tao ends the process on `WM_ENDSESSION`); only
the latest handoff is tracked, so a second Stop during a save is answered
`notSaved`.

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
upstream PRs #22/#38, qualification, and release status. These changes are source work;
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

The native event updates Settings › Transcription › Speakers, onboarding's
optional-download card, and open speaker dialogs. The frontend `optional-model-preferences-changed` DOM event
also refreshes preference views for frontend-triggered changes. These events are
different transports; neither is itself the persisted source of truth.

Read [NEMOTRON_NATIVE_ACTIVATION.md](NEMOTRON_NATIVE_ACTIVATION.md) for the regression
and installed-app test. Read [V0219_BACKGROUND_SETUP.md](V0219_BACKGROUND_SETUP.md)
and [V0220_OPTIONAL_ACTIVATION.md](V0220_OPTIONAL_ACTIVATION.md) as historical notes;
later fixes supersede earlier behavior. The post-v0.2.18 follow-up moves optional
Whisper activation into `whisper_download_model(enablePostCall=true)` and adds
native `uninstall_optional_model` ownership in `optional_models.rs`; see the
updated native-activation note for locking, settings events, tests, and limits.

### Settings › Transcription

The page is organized by meeting step: *During the meeting* and *After the
meeting* pickers (live and post-call models), meeting language, faster live
text, vocabulary, Speakers, and the Parakeet and Whisper model lists. The
optional Whisper and Nemotron downloads live on the steps that use them. Owners,
data flow, tests and limits are in [SETTINGS_UX.md](SETTINGS_UX.md).

### Model catalog and model updates (#50)

`model-catalog/catalog.json` on `main` lists the Whisper, Parakeet and built-in
summary models; the feature note is [MODEL_CATALOG.md](MODEL_CATALOG.md).

| Owner | Role |
| --- | --- |
| `src-tauri/src/model_catalog/schema.rs` | Entry rules (mirrored by `scripts/model-catalog/check-catalog.mjs`, shared cases in `scripts/model-catalog/test/entry-cases.json`); one bad entry is hidden alone |
| `model_catalog/mod.rs` | The embedded catalog and the one in use; `entries`, `entry`, `offered`, `entries_with_installed` for the engines |
| `model_catalog/remote.rs`, `service.rs`, `commands.rs` | Fetch from `main` and cache (`<app cache>/model-catalog/`), the daily check on the updater's schedule tick, `model-catalog-changed`, the IPC commands |
| `model_catalog/huggingface.rs` | Commit, sizes and SHA-256 from the Hugging Face API; blob-id check of Git files |
| `model_catalog/sizes.rs` | Display sizes of models not installed: one tree listing per repository, asked for by a shown list, kept in `sizes.json`, read again by the check |
| `model_catalog/installed.rs` | Install records beside each model; the frozen 0.3.0 pins for 0.3.x installs; where a download resumes |
| `model_catalog/updates.rs` | Update check (no download), staging, test load hooks, journaled swap with rollback, launch recovery |
| `lib/model-catalog.ts`, `components/ModelUpdateControl.tsx`, `components/updater/ModelCatalogSettings.tsx` | Status mirror, the card's update notice, Settings › About's Models block |

The engines (`whisper_engine.rs`, `parakeet_engine.rs`, `summary_engine/models.rs`
and `model_manager.rs`) take their lists, display data, expected pins and
download sources from it; `WHISPER_MODEL_CATALOG` and the engines' pin tables
are gone. The catalog has no sizes: `ModelInfo.size_bytes` is the install
record's (or the 0.3.0 pins') total for an installed model, else
`sizes::download_size`, and `None` while unknown; Corrupted/Incomplete compare
with the exact size of the version on record. Model updates hold `BusyReason::ModelDownload`, wait for the rest of
the busy registry, and swap under the engine lifecycle lock.

### Model integrity

`model_integrity.rs` (ported from leyvanah/Talkkeeper, MIT) checks every model
download against a pin: the exact size and SHA-256 of each file. For the
catalog's models the pins are resolved from Hugging Face at run time and kept
in install records (see above); models installed by 0.3.x are checked against
the 0.3.0 pins in `model_catalog::installed`. Pyannote/WeSpeaker and Nemotron
stay pinned in `model_integrity.rs` with commit-pinned Hugging Face URLs, and
its module comment records how their hashes were obtained. The bundled
Pyannote/WeSpeaker files are byte-identical to public files (onnx-community
segmentation-3.0, WeSpeaker's own ResNet34-LM export, pyannote community-1's
x-vector transform), and the repair download takes each from its source at a
pinned commit; their qualification against the 0.3.0 files is in
[DIARIZATION_MODELS.md](DIARIZATION_MODELS.md).

Failures are `IntegrityError` values that callers tell apart with
`downcast_ref`: `WrongSize` (file on disk of another size, kept), `ServerSize`
(announced length differs, nothing written), `Mismatch` (content differs;
`undeleted` holds the OS error when the delete failed) and `Cancelled`. Errors
cross IPC as text, so the UI matches the phrases "was deleted", "could not be
deleted" and "Nothing was deleted".

- Download: `Check` hashes while streaming and refuses bytes past the pinned
  size; `Check::resume` re-reads a kept partial first (Parakeet, GGUF). Diarization
  keeps its `.part` + rename flow on the same checker. A mismatch deletes the
  file, or says it could not; the shared download toast (`categorizeError`)
  shows each outcome, and a wrong `Content-Length` (Whisper, GGUF) as "the
  server sent a file of the wrong size. Nothing was deleted". Hashing a kept
  partial or a complete file already on disk (`ensure_verified_cancellable`)
  polls the download's cancel flag between 1 MiB reads, so Cancel ends it at
  once (the summary `cancel_download` waits only 5 s). Progress reported while
  bytes stream in stops at 99% (Whisper, summary and Parakeet callbacks and
  statuses, diarization events); 100% and the "Download completed" log line
  follow a matching hash, and a mismatch logs only the failure. Diarization
  sends 100% only with its final "done" event.
- Startup (`discover_models`, `scan_models`) checks only exact pinned sizes. A
  file that failed and could not be deleted (held open by another program
  without delete sharing) gets a `<file>.rejected` marker tied to its size and
  mtime; discovery then lists it as Error (Whisper) or Corrupted (Parakeet,
  summary) instead of available. Rewriting or deleting the file lifts it.
- Load: Parakeet `load_model`, Whisper `load_model` and `generate_with_builtin`
  call `ensure_verified`. A `<file>.verified` marker (pin, size, mtime) written
  after a verified download makes this two metadata reads; without one the file
  is hashed once off the async runtime, so models from older builds are checked
  on first use, not at startup. Only a full-size file that does not match is
  deleted; a file of another size is refused and kept, because it may be a
  partial kept for resume or one a download is writing.
  - Whisper and Parakeet hash only models whose status is Available, so an
    active download (status Downloading) is never touched; they set Error only
    for a mismatch.
  - `generate_with_builtin` is reached without a readiness check from the live
    assistant and the person and group questions. It goes through the
    registered `ModelManager::verify_before_load`: it refuses while a download
    of the model runs ("is still downloading"), and after a failed check sets
    the cached status to Error with the reason (deleted) or Corrupted (not
    deleted), so Settings says why and offers the download again. The summary
    status is internally tagged, so its error is the struct variant
    `Error { message }`, `{ type: 'error', message }` in `BuiltInModelStatus`.
    `BuiltInModelManager.tsx` lists the models again after a download error
    event and shows that message. Its callers show the reason without logging
    it, so `generate_with_builtin` logs every refused check with the model name:
    an error for a mismatch (deleted or not), a warning for a file refused and
    kept (still downloading, partial, unreadable).
  - Recording start then says the model failed its integrity check, and whether
    it was deleted, instead of "still downloading": `model_unavailable_message`
    in `recording_commands.rs` for native starts, and `modelIntegrityMessage`
    (`recording-start-errors.ts`) for the Record button, which loads the model
    itself in `prefetchSttModel`.
- UI text: the raw message carries two 64-character hashes. Every place that
  shows it uses `[overflow-wrap:anywhere]`: the import and retranscribe dialogs,
  the Ask AI error in `ChatThread.tsx`, the built-in model card, the optional
  model downloads and the onboarding download step. `break-words` is not enough
  in a dialog: its content is a grid item, and `overflow-wrap: break-word` does
  not lower the min-content width that sizes the grid track. The download toast
  replaces integrity messages with fixed text.

Tests: `model_integrity::tests` (hash and size mismatch, a file of another size
kept, a file that cannot be deleted reported and rejected, oversize refusal,
resume, cancellation between reads, marker invalidation, future size, every URL
commit-pinned), Parakeet and Whisper load-path tests with tampered files,
`discovery_does_not_list_a_failed_model_that_could_not_be_deleted` (Whisper),
the summary tests `the_live_assistant_keeps_a_partial_or_downloading_model`,
`a_full_size_model_that_fails_its_hash_is_deleted_and_offered_again`,
`cancel_stops_hashing_a_kept_model_at_once` (with its Parakeet twin
`cancel_stops_hashing_a_kept_file_at_once`; both resume a recorded download, so
they stay offline),
`every_status_serializes_with_its_tag_and_round_trips` and
`the_model_list_serializes_after_a_failed_download`, consistency of the 0.3.0
pins with the built-in catalog (`model_catalog::installed`) and of the Nemotron
pins, `tests/download-progress/errors.test.ts`,
`tests/download-progress/builtin-manager.test.tsx` (an error status shows its
message, wrapped, and Retry) and `tests/lib/recording-start-errors.test.ts`. The
delete-failure tests hold the file open without `FILE_SHARE_DELETE` and run on
Windows only. Whisper and summary downloads take their URL, pin and HTTP client
through an internal `download_pinned`, so
`a_download_reports_100_percent_only_after_the_file_matched` and
`a_download_that_fails_its_check_never_reports_100_percent` (one pair per
engine) download a small file from `model_integrity::testing::serve_once` and
follow the progress callback. `progress_of_unchecked_bytes_stays_below_100_percent`
(diarization) and `a_deleted_model_is_logged_as_an_error_and_a_kept_one_as_a_warning`
(summary client) cover the event percent and the log level.
The ignored `model_integrity::tests::small_pinned_files_match_what_their_sources_serve`
streams the two small diarization files (about 0.1 MB) from Hugging Face, and
`pyannote_files_match_what_their_sources_serve` the three Pyannote files (about
33 MB); run them with `--ignored` when changing a pin.
`bundled_pyannote_files_are_their_pinned_public_files` (`diarization/download.rs`)
hashes the bundled copies against the same pins on every test run. Parakeet
downloads run against the local Hugging Face stand-in of `model_catalog::testing`.
Limits: the diarization download paths are not exercised against a server (their
URLs and pins are not injectable), Pyannote copies in the user folder are still not
hashed at load, and Nemotron is still hashed on every load by `nemotron.rs`.

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

### ONNX Runtime

Silero VAD, Parakeet, Pyannote/WeSpeaker and Nemotron run on ONNX Runtime
through `ort` 2.0.0-rc.15 with API level 24 (`api-24`, ONNX Runtime 1.24) on
every platform (#70; rc.10 and 1.22.0 before):

| Platform | Runtime | Loaded |
| --- | --- | --- |
| Windows x64 | `Microsoft.ML.OnnxRuntime.DirectML` 1.24.4 and `Microsoft.AI.DirectML` 1.15.4 (NuGet) | `load-dynamic`, by absolute path from `binaries/onnxruntime/`; `DirectML.dll` is preloaded by absolute path |
| Linux x64 | Microsoft's `onnxruntime-linux-x64-1.24.4` (GitHub release), CPU only | `load-dynamic`, `binaries/onnxruntime/libonnxruntime.so` from the deb's or AppImage's resources |
| macOS arm64 | pyke's 1.31.0 CoreML build, downloaded by `ort` (`download-binaries`) | linked statically |

- `build/onnxruntime.rs` downloads the Windows and Linux archives and checks
  the size and SHA-256 of each archive and of every file it stages (Linux
  stages `libonnxruntime.so.1.24.4` as `libonnxruntime.so` and the license).
  `tauri.windows.conf.json` and `tauri.linux.conf.json` bundle
  `binaries/onnxruntime/*`. Linux does not use ort's own binaries: their 1.31.0
  build needs glibc 2.38 (`__isoc23_strtol` and relatives), more than the
  `ubuntu-22.04` release runner has, and a CPU with AVX2; Microsoft's build
  needs glibc 2.27 and no AVX2.
- `onnx_runtime.rs` owns the process's only `ort` environment (rc.14 makes it
  explicit and allows one per process); every session is built from
  `onnx_runtime::environment()`. On Windows and Linux it refuses a library
  older than API 24 (`ort::util::probe`) before ort loads it, lets
  `ort::init_from` report a library that does not load, and logs
  `Initialized verified bundled ONNX Runtime 1.24.4: <ort::info()>`, the
  version as the runtime reports it (`ort::info()` of Microsoft's builds names
  only the commit). The Linux release leg checks that line and the library
  inside the deb and the AppImage.
- Every app session starts from `onnx_runtime::session_builder`:
  - `AutoDevicePolicy::PreferCPU`. With API 22 or later ort gives every new
    builder ONNX Runtime's `MaxEfficiency` device policy, under which a
    session that registers no execution provider may be placed on an NPU or
    CoreML. ort's CPU provider registers none with ONNX Runtime (it only
    switches the memory arena), so it does not count; DirectML does and takes
    precedence. The vendored Silero sets the same policy.
  - Intra- and inter-op spinning off. Since 1.23 ONNX Runtime's idle worker
    threads spin with `TPAUSE` on Intel CPUs that have it
    (`core/common/spin_pause.cc`; still so in 1.26). On an Intel Core Ultra
    X7 358H that made Parakeet four times and Pyannote two and a half times
    slower than 1.22. Without spinning, 1.24.4 transcribed 20 minutes of a
    meeting in 47–55 s against 113–120 s on 1.22.0, and Pyannote and Nemotron
    took as long as before (#70). Silero runs on one thread and has no pool.
- Silero VAD is a vendored copy of silero-rs (`vendor/silero-rs`, see its
  `VENDORED.md`): upstream pins ort rc.10 and has no constructor that takes an
  environment. Its build downloads the Silero VAD v4 model (pinned size and
  SHA-256, the file the git dependency embedded before) instead of keeping
  the binary in git.

Tests: `onnx_runtime::tests` (Windows and Linux) load the staged runtime once,
check that it reports 1.24.4 and build sessions from the shared environment,
run the bundled Pyannote models, and keep a missing runtime a recoverable error;
`onnx_runtime_build_tests` checks the stage against the pins. The ignored
model tests and the before/after comparison on a recorded meeting are in
#70's pull request. Not run here: the macOS and Linux builds, which only the
release workflow builds.

### Whisper engine

Whisper runs on whisper.cpp 1.8.3 through `whisper-rs` 0.16 (`whisper-rs-sys`
0.15) on all three platforms (#63; 1.7.1 before); `whisper_rs::WHISPER_CPP_VERSION`
names the vendored version. `whisper_engine.rs` reads results through
`WhisperState::as_iter()` segments. Engine behaviour that changed with 1.8 and
what Protocol does about it:

- The no-speech threshold (0.55, Labs 0.45) now takes effect, but whisper.cpp's
  no-speech probability stays near zero with a set language, so it removed
  nothing on the measured meeting; see
  [Feature 8](LABS_MACWHISPER_FEATURES.md#feature-8-whisper-silence-guard).
- Inputs from 100 ms are decoded (1.7.1 returned nothing below 1 s); the
  measured post-call segments were all longer than 1 s.
- ggml-vulkan registers integrated GPUs as well as discrete ones, and
  whisper.cpp takes the first. `acceleration.rs::whisper_gpu_device` passes the
  first discrete GPU as `gpu_device` (else device 0), which keeps 1.7.1's
  choice on hybrid laptops and matches what the installer's Vulkan probe
  checks. Unit test: `gpu_device_is_the_first_discrete_gpu_among_whisper_devices`;
  no hybrid machine was available to test it on.
- 1.8 adds flash attention to the Vulkan backend, but `acceleration.rs` keeps
  it off there: on an Intel Arc B390 iGPU it made the post-call pass 41 %
  slower (20 meeting minutes in 251 s instead of 178 s) and the text no closer
  to a reference transcript. Metal and CUDA keep it on fast tiers.
- On the CPU (whisper.cpp's default of 4 threads; the app's `max_threads` is
  still not applied) a 20-second clip took 197 s instead of 252 s with Large
  V3 Turbo Compressed and 10.5 s instead of 7.9 s with Base.

The ignored test `an_installed_model_loads_and_transcribes` loads a model
(`PROTOCOL_WHISPER_TEST_MODEL`, read only) and transcribes a 16 kHz mono WAV
(`PROTOCOL_WHISPER_TEST_WAV`, optional `PROTOCOL_WHISPER_TEST_LANGUAGE`) on the
build's backend. Windows Vulkan builds need a short cargo target dir
([BUILDING.md](BUILDING.md#build-from-source-windows)).

### Windows installer

`frontend/scripts/build-universal-windows.ps1` builds the one Windows asset,
`protocol-windows-x64-setup.exe`: Tauri's NSIS installer, which is also the
updater's payload (run with `/P /UPDATE`). There is no CUDA build and no
bootstrapper any more (#15). `--features cuda` stays for development builds
(`frontend/build-cuda-env.bat lib|check|test`); its `bundle` mode and the
`tauri:build:cuda` script are gone because the installer ships no CUDA runtime.
The script builds the Vulkan variant and then the
CPU bundle in one target dir (only `whisper-rs-sys`, `whisper-rs` and `protocol`
recompile between them), copies the Vulkan executable to
`installer-variants\protocol-vulkan.exe` before `tauri build` relinks
`release\protocol.exe`, patches its bundle-type marker to `nsis` with
`scripts/release/patch-bundle-type.mjs` (the updater reads the marker; the
bundler patches only the executable it packages), and stages
`runtime-deps\DirectML.dll` and the pinned Visual C++ redistributable
(`stage-runtime-deps.ps1`, versioned download URL). It finds Visual Studio 2022
with vswhere and uses Ninja when present. It stops before building when the
cargo target dir is too long for the Vulkan build (31 characters with Ninja, 22
without): whisper.cpp 1.8 builds its Vulkan shader generator as a nested CMake
project whose compiler checks would pass Windows' 259-character path limit. With #31's updater configuration in
`tauri.conf.json` it gives `tauri build` a throwaway signing key; the release
workflow signs the final file again. Output: `dist\protocol-windows-x64-setup.exe`
and `dist\SHA256SUMS.txt`.

The installer is Tauri's standard one (#44): `windows/installer.nsi` is the
stock template of the CLI in `pnpm-lock.yaml` (2.12.4) and `windows/English.nsh`
its stock English text, with Protocol's changes marked `; Protocol:` (uninstall
key, install folder, branding text, `data\` on the uninstaller's delete-data
choice and that checkbox's wording; see `ARCHITECTURE.md` §8). A Tauri CLI
update re-bases both files on the new stock ones. The uninstall hook deletes
the files the hooks installed, which the bundle's file list does not name.
Checked for #44 on Windows 11 at 200 % scaling with QA-identity installers
(`Protocol QA`) built from one universal build: the new setup run
interactively over an install made by 0.4.0's template and hooks (default
"Uninstall before installing", which runs the old uninstaller), then with
`/P /UPDATE`, kept the folder, a single uninstall entry with the new
`DisplayVersion`, the saved `BackendOverride=cpu` and `data\`; a fresh install
chose Vulkan and kept it through `/P /UPDATE`; the uninstaller with the
delete-data box removed the folder, both registry keys, the shortcuts and the
identifier folders, and without it left only `data\`. The updater's own
end-to-end run is the `Updater end-to-end` workflow.

The bundled `protocol.exe` is the CPU build. `installer-hooks.nsh`
(`Meetily_SelectBackend`) runs `protocol-vulkan-probe.exe` and replaces
`protocol.exe` with the Vulkan build only when it finds a usable device, writes
`data\selected-backend.txt`, and deletes `installer-variants\`. An explicit
`/BACKEND=vulkan|cpu` is saved as `BackendOverride` under
`HKCU\Software\vmedvedevpro\Protocol` and reused by later installs and every
update; `/BACKEND=auto` clears it, and an uninstall that deletes app data removes
it with the key. This is the escape hatch for a driver that passes the probe but
crashes in inference: an update would otherwise select Vulkan again. In update
mode a failed Visual C++ setup only warns, because the files are already
replaced. Installs over a pre-0.3.0 build delete the CUDA DLLs it copied next to
`protocol.exe`. Without a CUDA build, `get_cuda_reconfiguration_status` reports
"not applicable" unless the app is built with `--features cuda`
(`CUDA_SETUP_AVAILABLE`), so the CUDA notice never shows.

`node frontend/scripts/verify-windows-release.mjs [dist]` checks the output
without installing: `SHA256SUMS.txt`, the NSIS archive (7-Zip; `SEVEN_ZIP`
overrides the path), the exact variant and runtime sets (no CUDA files), that the
bundled `protocol.exe` does not import `vulkan-1.dll` while the Vulkan build
does, the `nsis` marker on both, and that ffmpeg, llama-helper, ONNX Runtime and
the notices (`parakeet-rs-LICENSE.txt`, `THIRD_PARTY_MODELS.txt`) equal the
staged files. A local warm build took about 8 minutes and produced a 118 MB
installer (upstream's universal installer with CUDA was 674 MB).

### Releases

Releases are built by `.github/workflows/release.yml`, never locally; the
procedure, dry runs and the `release` environment are in
[WORKFLOWS_OVERVIEW.md](../.github/workflows/WORKFLOWS_OVERVIEW.md). Pull
requests run only `pr-checks.yml`; every push to `main` that changes more than
documentation also runs this workflow as a dry run and `updater-e2e.yml` (#65).
Data flow:

1. A release PR runs `scripts/release/bump-version.mjs <version>`: the version in
   `tauri.conf.json`, `frontend/src-tauri/Cargo.toml`, `Cargo.lock` and
   `frontend/package.json`, and `## Protocol <version> — <date>` in `CHANGELOG.md`.
2. Once the merged commit's `main` runs of `release.yml` and `updater-e2e.yml`
   are green, the owner pushes the tag `v<version>` on that commit.
   `validate-release.mjs` checks the tag format, that the commit is on
   `origin/main`, the version files, the CHANGELOG section (it becomes the notes),
   the published releases (no duplicate, above every non-draft release whatever
   its prerelease flag, so a release taken off Latest keeps counting), the updater
   configuration and the locked tauri-cli's `--app-version` support, and
   `check-migration-checksums.mjs --source git` the migration table.
3. `pr-checks.yml` runs as a reusable workflow, then the legs
   `release-build-{windows,macos,linux}.yml` build, test and smoke-test, and each
   uploads a `leg-<platform>` artifact with its `SHA256SUMS.txt` (the assembly
   downloads exactly `leg-*`). Legs have no secrets.
4. `draft` (environment `release`, tag runs only) runs `assemble-release.sh`:
   checks the artifacts, signs the three updater payloads with the production key
   and `--app-version`, verifies the signatures against `plugins.updater.pubkey`
   (`verify-updater-signature.mjs`), writes `latest.json` (`make-latest-json.mjs`),
   `SHA256SUMS.txt` and the notes (`render-notes.mjs`), then attests the installers
   and creates the draft; `check-release-assets.mjs` compares the uploaded assets
   with the local files. Dry runs run the same script in `preview` with a
   throwaway key.
5. The owner publishes; `release-published.yml` (`check-published-release.mjs`)
   checks the public assets, the feed and `/releases/latest`.

The feed has `windows-x86_64-nsis` and `windows-x86_64` (both the setup),
`darwin-aarch64-app` and `darwin-aarch64` (`protocol-macos-arm64.app.tar.gz`) and
`linux-x86_64-appimage`, and deliberately no `linux-x86_64` or deb key: a deb
install finds no entry and gets #31's download link instead of an AppImage.
Signatures carry the version (`signer sign --app-version`, tauri-cli 2.12 from
#33); `verify-updater-signature.mjs` checks it. Until #31's configuration is in
`main`, dry runs warn about it and the macOS leg adds a throwaway updater
configuration so the `.app.tar.gz` is still built; tag runs fail.

**Migration checksums.** sqlx stores a SHA-384 per applied migration and refuses
a binary whose embedded bytes differ. The ten historical migrations
(`20250916100000` … `20251229000000`) have no `eol` attribute and were released
from CRLF checkouts on Windows, so their checksums differ per platform; newer
ones are `eol=lf`. `frontend/src-tauri/released-migration-checksums.json` records
both columns; `check-migration-checksums.mjs` recomputes them from git blobs in
`pr-checks.yml` and `validate`, and every leg checks the working tree it compiles
after setting `core.autocrlf` explicitly. The authoritative check is the Rust test
`embedded_migrations_match_released_checksums` (`database/manager.rs`) over the
embedded `MIGRATOR`. The Windows column matches the owner's two real databases.
A new migration needs an `eol=lf` line in `.gitattributes` and
`check-migration-checksums.mjs --add-new`, run after `git add`: it hashes the
staged blob and refuses an untracked migration or one with unstaged changes.

Tests: `node --test "scripts/release/test/*.test.mjs"` (in `pr-checks.yml`);
the Rust test above and the CUDA status test in
`whisper_engine::commands::cuda_reconfiguration_tests`. Remaining limits: builds
are unsigned (SmartScreen and Gatekeeper warnings); Linux packages are built and
started in CI only, and their native tests do not block; a release run with cold
caches takes about 40 minutes (the Windows leg about 35), and whether tag runs
restore the caches `main` runs save is not yet observed; `llama-helper` is
CPU-only on Windows and Linux; the Vulkan/CPU choice happens at install and
update time, not at launch.

### Fork identity and updates

Protocol is a fork of Meetily – Actually Free with its own identity, so it can run
beside an installed upstream build without sharing state:

| Surface | Value | Owner |
| --- | --- | --- |
| Bundle identifier, Windows AUMID | `io.github.vmedvedevpro.protocol` | `tauri.conf.json`, `notifications/native_windows.rs` |
| Product name, install folder | `Protocol`, `%LOCALAPPDATA%\vmedvedevpro\Protocol` | `tauri.conf.json`, `windows/installer.nsi` (`INSTALLDIRNAME`, a `; Protocol:` change to Tauri's stock template) |
| Installer registry key | `HKCU\Software\vmedvedevpro\Protocol` (install folder, `BackendOverride`) | `bundle.publisher` + product name (stock `MANUPRODUCTKEY`); `windows/installer-hooks.nsh` |
| Uninstall entry | `HKCU\…\Uninstall\io.github.vmedvedevpro.protocol` | `windows/installer.nsi` (`UNINSTKEY`, a `; Protocol:` change to Tauri's stock template) |
| Fallback data root | OS data dir `/vmedvedevpro/Protocol` | `paths.rs` (`FALLBACK_PUBLISHER`, `FALLBACK_APP_NAME`) |
| Default recordings folder | `protocol-recordings` | `audio/recording_preferences.rs` |
| Cargo package and executable | `protocol`, `protocol.exe`; installer variants `protocol-vulkan.exe`, `protocol-vulkan-probe.exe` | `src-tauri/Cargo.toml`, `build-universal-windows.ps1`, `windows/installer-hooks.nsh` |
| Release assets | `protocol-windows-x64-setup.exe`, `protocol-macos-arm64.{dmg,app.tar.gz}`, `protocol-linux-x86_64.AppImage`, `protocol_<version>_amd64.deb` | `scripts/release/release-lib.mjs` |

The identifier also keys the single-instance lock, WebView storage, plugin
stores, and the legacy `app_data_dir` migration in `paths.rs`; under the old
identifier a first run would copy an installed upstream build's models and
database. Internal names stay upstream-compatible to keep merges cheap:
`MEETILY_*` environment variables and localStorage/event keys.

The in-app updater (#31) replaces upstream's removed one (`app_update.rs`, the
update dialog, the onboarding consent step; the CUDA launch notice that lived
there is `components/CudaReconfigurationNotice.tsx`). It works like Orca's:
a daily background check, a download only when the user clicks **Download**,
and an install on **Restart and update** or on quit, never while Protocol is
busy. The feature note is [AUTO_UPDATE.md](AUTO_UPDATE.md).

| Owner | Role |
| --- | --- |
| `src-tauri/src/updater/mod.rs` | `UpdaterState` (managed), the scheduler task, `check_now`, `request_download`, `quit_app`, `install_and_restart`, the `updater-status` event |
| `updater/status.rs` | Pure state machine: activity (idle, checking, downloading, installing) and the offered release (downloaded or not), errors with user-visible vs background origin |
| `updater/busy.rs` | Busy registry: owner getters (recording, stopping, the meeting save handoff, import, retranscription, summaries, onboarding), RAII `hold` guards (diarization, model downloads), the WebView lease (`recordingSave`, `postCall`, 150 s) |
| `updater/install.rs` | Install gate (engine lifecycle lock, busy re-check), exit preparation, per-platform install |
| `updater/engine.rs`, `cache.rs`, `schedule.rs`, `prefs.rs`, `support.rs`, `journal.rs` | Plugin calls and error mapping, the verified download cache and install marker, check timing and backoff, `updater.json` preferences, which installs can update, `updater.log` |
| `model_catalog/service.rs` | The model list and model update check, run from the same scheduler tick and switch (see [MODEL_CATALOG.md](MODEL_CATALOG.md)) |
| `tray.rs`, `quit.rs` | Check for Updates, the available or ready version, Restart to Update; Quit through `quit::request`, which saves a running recording first and then calls `updater::quit_app` |
| `contexts/UpdaterContext.tsx`, `lib/updater.ts` | Snapshot mirror, commands, every user-visible sentence |
| `components/updater/*` | Sidebar pill and panel, Settings › About block, toasts, `UpdaterActivityReporter` |

Data flow: scheduler (every 10 min, first at 2 min, gated on onboarding and the
switch) → `check` → offer → toast and pill → user clicks **Download** → signed
payload verified and cached in `app_cache_dir()/updates` → **Restart and
update** or Quit → gate → `prepare_exit` → plugin install → next launch reads
the install marker. Tests: `cargo test -p protocol --lib updater::` and
`frontend/tests/updater/`. What ran end to end is recorded in AUTO_UPDATE.md.

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

Seventy IPC commands that nothing in the app called were removed together with
the code only they used ([#22](https://github.com/vmedvedevpro/Protocol/pull/22),
part of [#3](https://github.com/vmedvedevpro/Protocol/issues/3)); every
feature works as before. Seven of them took a path, URL, or endpoint from the
WebView without checks or widened the asset protocol scope: `read_audio_file`
(read any file), `save_transcript` (write any file), `diarize_recording`
(decode any audio file), `ollama_embed` (send transcript text to any endpoint),
`detect_legacy_database` (probe whether a file exists),
`get_ollama_model_context` (send a request to any endpoint), and
`get_meeting_playback_audio` (added a meeting's audio file to the asset
protocol scope). The other 63, by area:

- Parallel Whisper processing: `initialize_parallel_processor`,
  `start_parallel_processing`, `pause_parallel_processing`,
  `resume_parallel_processing`, `stop_parallel_processing`,
  `get_parallel_processing_status`, `get_system_resources`,
  `check_resource_constraints`, `calculate_optimal_workers`,
  `prepare_audio_chunks`, `test_parallel_processing_setup`.
- Notifications (recording notifications are unchanged):
  `request_notification_permission`, `show_notification`,
  `show_test_notification`, `is_dnd_active`, `get_system_dnd_status`,
  `set_manual_dnd`, `set_notification_consent`, `clear_notifications`,
  `is_notification_system_ready`, `initialize_notification_manager_manual`,
  `test_notification_with_auto_consent`, `get_notification_stats`.
- Console window: `show_console`, `hide_console`, `toggle_console`.
- System audio capture and monitoring: `start_system_audio_capture_command`,
  `list_system_audio_devices_command`, `check_system_audio_permissions_command`,
  `start_system_audio_monitoring`, `stop_system_audio_monitoring`,
  `get_system_audio_monitoring_status`.
- Audio backend selection: `get_available_audio_backends`,
  `get_current_audio_backend`, `set_audio_backend`, `get_audio_backend_info`.
- The old HTTP backend: `api_get_profile`, `api_save_profile`,
  `api_update_profile`, `test_backend_connection`, `debug_backend_connection`.
- Search, settings, and templates: `api_search_transcripts` (replaced by the
  global search), `api_get_transcript_api_key`, `api_get_template_details`,
  `api_validate_template`.
- Recording and devices: `start_recording_with_devices`,
  `is_audio_level_monitoring`, `is_recording_paused`, `poll_audio_device_events`,
  `get_reconnection_status`, `get_active_audio_output`.
- Meeting detection: `start_meeting_detection`, `stop_meeting_detection`;
  detection still starts at launch and follows its setting.
- Diarization: `diarization_model_directory`, `diarization_download_size`,
  `get_diarization_engine`.
- Other queries: `whisper_unload_model`, `is_compact_mode`,
  `is_import_in_progress_command`, `check_screen_recording_permission_command`,
  `request_screen_recording_permission_command`, `select_legacy_database_path`,
  `reset_onboarding_status_cmd`.

Two frontend calls to unregistered commands, which could only fail with
"Command not found", went too: `api_get_auto_generate_setting`, which the Model
Settings view sent on every mount for a switch that was already hidden (Auto
Summary keeps its own setting), and the unused `builtin_ai_get_models_directory`
wrapper. PR #22 lists what each removal took with it and what stayed.

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

Upstream published macOS separately, through `publish-macos.yml` and
`MACOS_RELEASE.md` (an explicitly labeled CI-qualified preview, a separate
non-Latest prerelease, a physical checklist for stable releases). Protocol removed
that process in #15; macOS is a leg of `release.yml` and its notes below are
upstream history. The `v0.2.19-macos` preview packages the upstream #42 callback change;
build `36790029640` and published-asset smoke test `36790877680` passed. It remains
unqualified for physical microphone capture and the reporter's device. The
Windows Latest release is now v0.2.20; see
[upstream/RELEASE_V0220_QUALIFICATION.md](upstream/RELEASE_V0220_QUALIFICATION.md) for Windows build,
hardware-capture, installed-upgrade, and public updater verification.
The `v0.2.20-macos` follow-up packages explicit worker shutdown and short-gap
source recovery for upstream #42. Apple Silicon build `36876715270` passed all 22 worker
and pipeline regressions plus bundle/launch checks; public smoke test
`36878960910` passed. See [upstream/RELEASE_V0220_MACOS.md](upstream/RELEASE_V0220_MACOS.md) for
provenance. Physical recording and live-transcription confirmation remain open.
Upstream's VirusTotal submission workflow was removed in #15.

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
| [LIVE_NEMOTRON_AND_PR36.md](LIVE_NEMOTRON_AND_PR36.md) | Live implementation, qualification, limitations, and assessed upstream PR #36 scope. |
| [PR34_NEMOTRON.md](PR34_NEMOTRON.md) | Model provenance, hardening, DirectML qualification, and release numbering. |
| [V0218_DOWNLOAD_FIX.md](V0218_DOWNLOAD_FIX.md) | Async stack-overflow diagnosis; keep large checksum buffers off the future's inline stack. |
| [NEMOTRON_NATIVE_ACTIVATION.md](NEMOTRON_NATIVE_ACTIVATION.md) | Native download/activation lifetime regression and verification. |
| [MODEL_CATALOG.md](MODEL_CATALOG.md) | The model list on `main`, Hugging Face resolution, install records, 0.3.x installs, model updates, tests and limits. |
| [upstream/UPSTREAM_0_4_1_PORTS.md](upstream/UPSTREAM_0_4_1_PORTS.md) | Selective upstream integration decisions. |
| [DIARIZATION_MODELS.md](DIARIZATION_MODELS.md) | Pyannote/WeSpeaker file provenance, qualification against the 0.3.0 files, voice-profile continuity, the 0.3.0 upgrade path, and how to repeat the measurements. |

The public release documented in README is distinct from a local candidate.
Development labels 0.2.18–0.2.20 in Actually Free's historical notes were
consolidated into its 0.2.17 candidate after checking its published 0.2.16.
Re-check the actual release state before future version work; do not treat this
historical statement as a permanently current release number.
