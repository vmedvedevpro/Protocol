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
| `frontend/src/features/recording/` | Frontend recording: the session store and its native sync (`store/session.ts`, `store/runtime.ts`), the start order (`store/start.ts`), live lines and the IndexedDB crash copy (`api/transcript.ts`, `api/recovery.ts`), the save after Stop (`store/save.ts`) and the post-call pass (`store/postCallRunner.ts`). [UI_ARCHITECTURE.md › Recording](UI_ARCHITECTURE.md#recording) describes them. |

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
2. WebView, `frontend/src/features/recording/store/save.ts` (`saveAfterStop`,
   heard by `RecordingRuntime` on every screen): discards a take under 10
   seconds; otherwise polls `get_transcription_status` until the queue is
   empty (at most 60 s), waits 4.5 s for late transcript events, saves the
   meeting and transcript rows (`api_save_transcript`), files the meeting
   into the folder picked while recording, saves the notes and the summary
   language, marks the IndexedDB recovery record saved, and opens
   `/meetings/:id` and queues post-call processing. A wait that times out or
   fails saves nothing and answers `notSaved`; the record stays for
   recovery.
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

`quit.rs` owns user quits: tray Quit, on macOS ⌘Q and Dock Quit
(`RunEvent::ExitRequested { code: None }`, held back by `quit::holds_exit`),
and on Unix SIGTERM and SIGINT (logout, shutdown, `kill`, Ctrl+C;
`quit_on_termination_signals`, tokio's signal streams), so a signal ends in
`RunEvent::Exit` and the crash session is marked clean instead of being
reported as an unclean shutdown on the next start (#121). The first signal
asks as tray Quit does; a second one exits at once (on a logout nobody
answers, and the session manager's SIGKILL would follow), and no signal
installs a downloaded update, which a logout would kill midway
(`on_signal`). After **Stop and quit** saved the meeting, only a recording
started meanwhile asks again; other busy work does not, since the user
already chose to quit. `plan` reads
recording state (running, stopping, or saving through the handoff), the other
work `updater::busy::current` reports, and whether a downloaded update would
install. Busy work without a recording (the post-call pass, a
retranscription, speaker identification, a summary, an import, a model
download or GPU compile; unfinished setup does not count) asks "Protocol is
still busy: <the work>. Quit anyway?" with **Quit anyway** and **Cancel** (#121: tray
Quit during the post-call pass used to quit at once). With nothing busy the
quit goes to `updater::quit_app` as before. With recording work the main window leaves
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
`frontend/src/features/recording/store/save.test.tsx` (the answer for each
ending, no meeting page and no post-call pass when quitting, the `stop_id`
hand-over). Limits: Stop and quit does not run
speaker identification or the automatic summary; **Quit anyway** ends busy
work with the process (a summary cut off this way stays pending, a built-in
model download or a Whisper one resumes from its partial file); Windows shutdown
and log-off exit without asking (tao ends the process on `WM_ENDSESSION`); only
the latest handoff is tracked, so a second Stop during a save is answered
`notSaved`.

### Linux audio devices (#216)

On Linux the device select, recording and the level preview use the sound
server, PipeWire (through `pipewire-pulse`) or PulseAudio, not cpal. cpal
0.15 only has an ALSA host there: listing its inputs opened all 25 ALSA PCMs
of the owner's laptop on each call (about 1,800 `pcm_dmix ... supports only
playback stream` lines an hour on stderr), named them by raw PCM names
(`dsnoop:…`, `plughw:…`) and never saw a monitor source, so computer audio
was not found at all.

- `audio/pulse/mod.rs` finds the server's socket as libpulse does
  (`$PULSE_SERVER`, `$PULSE_RUNTIME_PATH`, `$XDG_RUNTIME_DIR/pulse/native`)
  and speaks the PulseAudio protocol with the pure-Rust `pulseaudio` crate
  (no libpulse to link or ship; cpal 0.18's PulseAudio host uses the same
  crate). Its `Client` is not used: its reactor ignores `RecordStreamKilled`.
  One blocking connection per listing and one per record stream, each with a
  3-second reply timeout. A `$PULSE_SERVER` that names no local socket that
  exists (a TCP server, a stale path) is an error naming the variable and
  its value, logged by the listing and shown in Settings, the inputs menu
  and onboarding's microphone check; only with no socket at all is ALSA
  offered. Auth sends libpulse's cookie (`$PULSE_COOKIE`,
  `$XDG_CONFIG_HOME/pulse/cookie`, `~/.pulse-cookie`; `choose_cookie`), or
  256 zero bytes when it is missing, unreadable or of another length, and
  logs which case applied once: `pipewire-pulse` lets the user's own socket
  in by its credentials but refuses a cookie of another length, which left
  a fresh profile without a microphone.
- `audio/pulse/devices.rs` lists sources in one round trip without opening a
  device: inputs, and the monitor of each output ("Monitor of …") as
  computer audio. A device is shown and stored by the server's description;
  two that share one get the server's name in brackets. The choice survives
  a restart and a reconnect because the server gives a device back under
  the same description and name, whatever its index. A listing asked for
  while another runs waits for it and takes its answer (`LAST`), so Settings,
  the inputs menu and a recording start do not each list again.
  `discovery.rs` runs it on a blocking thread.
- A stored label is looked up by `Listing::find`: exactly; by the server's
  name in its brackets (a twin's label once the other twin is gone); a plain
  label two twins now share is ambiguous, not either of them; and the forms
  Linux stored before #216, each only where it names one device: ALSA's
  `default`, `pulse`, `pipewire` and "ALSA default input" are the default
  input, a hardware PCM (`hw:CARD=X,DEV=N`, `plughw:`, `dsnoop:`, `front:`,
  `sysdefault:CARD=X`) is the one input with that `alsa.card` and
  `alsa.device` (the card id resolved through `/proc/asound`), and
  "<name> (System Audio)" is a monitor with that server name or label.
  `get_recording_preferences` answers a matched device under its current
  label, so the select and the bar do not call it missing. Settings sends
  every preference back on any change, so `set_recording_preferences`
  keeps the stored value when the device sent is only its current label
  (`kept_device_name`): a gain change does not turn a twin's bracketed
  label or an ALSA `default` into a plain label. Choosing another device
  saves it.
- `audio/devices/platform/linux.rs` resolves a stored device to a source
  name (`Capture::SoundServer`). Without a sound server only "ALSA default
  input" is offered (cpal's ALSA `default`), and computer audio reports that
  it needs PipeWire or PulseAudio.
- A recording start that cannot open the stored microphone or computer
  audio records the default instead and says so in the warning toast
  (`recording_commands.rs` `stored_or_default`, `substitution_warning`):
  "Your microphone “X” isn’t connected; recording from “Y”.", or that the
  name now matches several devices (choose one in Settings). "Isn’t
  connected" only for `MissingDevice`, which each platform returns when no
  device answers to the name; any other failure (a busy device, no usable
  format, the sound server) reads "couldn’t be opened (<reason>)", the
  error's outermost message cut to 120 characters. All platforms.
- `audio/pulse/record.rs` opens a record stream for that source as 48 kHz
  mono f32 (the server converts) with 20 ms fragments and `no_move`: an
  unplugged device ends the stream (`Ended::SourceRemoved` →
  `DeviceNotAvailable`) instead of the server moving it to another source.
  Its thread only reads the socket and enqueues blocks;
  `stream.rs::create_pulse_stream` gives them to the same `CaptureWorker`
  as Windows capture (the ALSA path uses it on Linux now too). Stop
  shuts the socket down, which wakes the thread's read at once.
- Timestamps come from the samples, not from arrival (`record.rs` `Clock`).
  PipeWire hands a record stream its audio per 1024-sample quantum, so 20 ms
  blocks arrive 21 ms apart with a 10 ms gap every 15 or so (measured with
  `parec` on this laptop); stamped on arrival, each block was 1.3 ms off the
  one before and the mixer padded or dropped the difference. Each block ends
  one block after the one before, never after it arrived; the clock restarts
  at arrival only when a block with nothing behind it lags by over 100 ms
  (the server lost audio, or the card's clock runs slow). A backlog after a
  stall keeps its capture times. A message announced over 4 MiB ends the
  stream as failed before anything is allocated for it.
- `simple_level_monitor.rs` opens the same streams for the level ring,
  matching the select's label exactly (an input first, then a monitor).

Tests: `cargo test -p protocol --lib audio::pulse` (naming, duplicate
descriptions, a reconnect under a new index, stored-label lookup with
twins and pre-#216 ALSA names, `PULSE_SERVER` errors, the cookie choice,
sample decoding, the capture clock against PipeWire's quantum, a backlog,
lost audio and a slow card, the message bound) and `substitution_tests` in
`recording_commands.rs` (the notice). Ignored ones
need a running server: `lists_the_running_sound_server`, and
`records_the_chosen_input_and_output_monitor`, which records two seconds from
the labels in `PROTOCOL_QA_INPUT` and `PROTOCOL_QA_OUTPUT` and checks
`PROTOCOL_QA_MIN_RMS`. Checked on Kubuntu 26.10 with PipeWire 1.6.8
(`pipewire-pulse`), with a virtual microphone (`module-remap-source` over a
null sink) and the monitor of a null sink, fed a 440 Hz and an 880 Hz tone:
the dev build in a fresh profile listed both by name, opened the stored
choice by name in onboarding's level preview, and recorded them into the
microphone and computer-audio tracks with only their own tone, the
microphone's tone level steady for 32 s. The laptop's own digital microphone
and speaker monitor recorded too. Not checked: PulseAudio itself, a system
without a sound server, Bluetooth headsets.

## 3. Post-call processing and model selection

**Meeting titles from the summary** (#218). The summary request already asks
for a title: the template's `# <Add Title here>` H1, which
`to_section_instructions` asks to fill with 3 to 8 words in the report's
language (the translation pass carries it into the summary's language).
`summary/service.rs` takes it from the final Markdown
(`processor.rs::extract_meeting_name_from_markdown` rejects an empty,
overlong or placeholder heading, so such a reply leaves the title as it was).
Every pass's reply goes through `clean_llm_markdown_output` first, which also
takes off an unclosed opening fence and the `<document>` tags the translation
and normalisation prompts wrap their input in: Gemma 3 1B echoed both, so its
Russian summaries showed as one code block and had no leading H1 to name the
meeting from. Before it emits `completed`, the service renames the meeting
through
`meeting_title::rename_meeting` with `TitleSource::Summary`, the path
`api_save_meeting_title` takes with `TitleSource::User`:
`MeetingsRepository::set_title` (database and legacy chunk names, one
transaction) and the folder's `metadata.json` `meeting_name` when the file
exists; the folder itself keeps its name, as a manual rename always left it.
Whose title it is lives in `meetings.title_is_manual`, an explicit record:
`api_save_transcript` takes `title_is_manual` from the recording (the
session's `titleManual`, also kept in the crash copy for recovery; absent
means the user's), `start_import_audio_command` takes it from the import
sheet (`titleIsManual`: the user changed the file name the sheet proposed;
absent means the user's), and a rename sets it for good. The title's text is never
read for it (the old `is_default_meeting_title` is gone), so the automatic
format can change (#219). A summary's title applies only while the record
says the app made the title (an SQL predicate, so a rename racing the run
wins) and leaves the record as it was, so a summary written again names the
meeting again until the user renames it. The shell's `useSummaryTitleSync`
reads the list, the meeting, folders and search again on `completed`.
Tests: `meeting_title::tests`, `meeting::tests`, `transcript::tests`
(native); `summaryTitleSync.test.tsx`, `save.test.tsx` and `ImportSheet.test.tsx` (frontend).
Older notes on the upstream behaviour: [SUMMARY_GENERATED_TITLES.md](SUMMARY_GENERATED_TITLES.md).

A summary run's template is `api_process_transcript`'s `template_id`. Without
one native takes the stored default (`summary/template_settings.rs`, #117): the
id in `default_summary_template.txt` in the data root while that template still
loads, else `standard_meeting`, the template the UI always sent (upstream fell
back to `daily_standup`). Settings › Summary templates stores it with
`api_set_default_template`, which accepts only a template that loads, so a
deleted custom default falls back by itself. The UI's
`startSummary` (`frontend/src/api/meetings.ts`) leaves the template out unless
a run picks one, so the automatic summary after a recording uses the default.
The module also reads one template whole (`api_get_template`) for its sections
and the editor; the frontend domain is `frontend/src/api/templates.ts`. Every
list of templates (Settings, Summary options, the template sheet) reads
`listTemplatesWithOrigin`, sorted by name, then id, whatever the default
(#218): choosing a default moves nothing and reads only the default again;
Settings marks it with its radio, Summary options with "(default)". Tests:
native `summary::template_settings::tests`, frontend `src/api/templates.test.ts`.

A cloud provider's models (Settings › Summary model and first launch) come
only from its API: `anthropic/`, `openai/` and `groq/` ask with the user's key
through `cloud_models.rs`, which has no built-in list and no cache. Anthropic's
Models API pages its answer (default 20), so `get_anthropic_models` asks for
1000 a page and follows `after_id`. A missing key, one with a character no
key has (a pasted line break, a space, non-ASCII), a rejected key (401, 403),
no answer within 10 s, another status, an unreadable answer or a client that
cannot be built is an `Err` (`ModelListError`, tagged by `kind`), which the
model row words by cause, offering Try again when the same key may work
(`src/api/summaryProviders.ts`); the UI keeps one query per key fingerprint,
so a list fetched with one key is never shown for another. `openrouter/` lists
the public catalog without a key. Tests: `cargo test -p protocol --lib --
cloud_models anthropic:: groq:: openai::` (a local HTTP server stands in for
the providers), frontend `SummaryModelPage.test.tsx`.

**Summaries and action items** (#218). A summary keeps its action section
as the model wrote it; nothing splits it into rows any more, and the app has
no commands for the `action_items` table (the meeting, person screen, search,
live assistant and MCP server read the summary text instead). Up to
1.0.0-rc.1 the UI moved the section into `action_items` rows and saved the
summary without it (`original_markdown` kept the full text,
`meetings.action_items_source` the text it read). At startup, after the
migrations, `DatabaseManager::new` runs
`database/repositories/action_item.rs::restore_action_sections`: for each
meeting not yet marked `restored-to-summary` it puts the section back
(from `original_markdown`, before the heading that followed it, else at the
end), adds the user's own rows (added or edited by hand) the text does not
name, or renders every row as an "Action Items" list when the summary was
edited after the move and has no original, drops stale editor blocks
(`summary_json`) so the editor rebuilds from the Markdown, and marks the
meeting in the same transaction. A data step rather than a migration: the
summary is JSON holding Markdown and the section is found with the old UI's
heading rules (ported to Rust), which SQL cannot express; a failed meeting
is logged and retried at the next launch, and the table itself stays as
released migrations left it (contact merges and deletions still keep its
owner links). A new summary no longer clears the marker. Tests:
`cargo test -p protocol --lib action_item` (headings, placement, user rows,
an edited summary, the startup step run twice), `global_search_tests`
(action text found as a summary), `protocol-mcp` tests (no
`get_action_items`, `get_meeting` shows the section inside the summary).

`diarization/mod.rs` owns persisted engine settings and offline command dispatch.
Nemotron is Auto-detect only; manual counts belong to Pyannote.
Pyannote clusters its turns (one local speaker of one non-overlapping 10 s
window) in `clustering::agglomerative` (#217). A cluster is a speaker only with
`MIN_SPEAKER_TURNS` (2) turns; smaller ones join the nearest speaker, so one
odd turn neither spends a chosen count nor shows on its own. The mic
voiceprint guard (`mic_is_one_consistent_voice`) reads the clusters before
that folding, `agglomerative_unfolded`, so an odd turn blocks enrolment. The
0.60 automatic threshold is not recalibrated.
Rerunning speaker identification must preserve transcript text, row identity,
and timestamps. `plan_labels` relabels every line from the new clusters: each
name the user gave goes to the cluster that overlaps its lines most, the
other clusters' lines get `Speaker N`. A line no voice overlaps keeps its
label; one with no usable timing keeps a given name only. A line moved on its own in Who said this
carries `speaker_manual` and keeps its label; `reassign_transcript_speaker_component`
sets it and clears it when the name is removed, a whole-speaker rename leaves
it. Lines moved before migration `20261126010000` carry no mark and are
relabelled. With a chosen count, a cluster that leads no line joins the line
it covers most. The result's `changed`, `labelled_before` and
`speakers_on_lines` drive the dialog's toast. Tests: `diarization::clustering`
and the `plan_labels` cases in `diarization/mod.rs`, the `speaker_manual` case
in `person.rs`, and the ignored, Linux-only
`qualification::a_chosen_count_is_spent_on_the_two_voices` on public fixtures.
`row_speakers` labels a row with the speaker who overlaps it most, then those who
overlap it for a fifth of that and talk at the same time; of speakers who overlap
it equally the lower index comes first (#75; it was hash order), so one timeline
always gives the same labels.
Read [PR34_NEMOTRON.md](PR34_NEMOTRON.md) before changing that contract.

Frontend post-call sequencing lives in
`frontend/src/features/recording/store/postCallRunner.ts`, mounted above
navigation through `RecordingRuntime` in the shell. A recording's save starts
it with retranscription, speakers and the summary; an import (#206) starts it
through `postCallControls.afterImport` from Import's sheet once the meeting is
filed, with speakers and the summary only, since the import transcribed the
file (tests: the import cases of `postCallRunner.test.ts` and
`ImportSheet.test.tsx`); screens read the job
(`src/api/postCall.ts`) and ask the runner to cancel, retry or skip. The old
UI (`162e8be`) had it in `components/MeetingDetails/PostCallProcessingWorker.tsx`
and `contexts/PostCallJobsContext.tsx`. Completion and
transcript refresh target the matching mounted meeting; inactive meetings refresh
on return. See [OCTOBER_PR_INTEGRATION.md](OCTOBER_PR_INTEGRATION.md) for cancellation
ownership and lifecycle limits. Related
speaker/retranscription dialogs. `useDiarizationEngine.ts` refreshes selected-engine
state for dialogs, including native activation events and stale-response guards.

Live ASR and post-call ASR defaults are independent. Optional Whisper activation
saves the **post-call** default; it must not replace the live Parakeet selection.

The post-meeting pass (`run_retranscription` and the import) shares
`audio/post_meeting.rs` (#62). With Whisper it cuts each track at pauses: the
batch VAD without its continuous-speech cap (`vad_cap`,
`ContinuousSpeechCap::PauseToPause`). A piece over 25 s is cut at the quietest
100 ms within 3 s of each 25 s mark (`split_segment_at_silence`; that point is
silent only when the recording has a pause there), except where less than 2 s
would remain: the VAD keeps 2 s of non-speech at a piece's end, so that rest
would hold no speech, and it stays with the piece, still under Whisper's 30 s
window. Both loops transcribe a
piece through `PieceTranscriber`. With Whisper, the pieces of a pass go through
one `PostMeetingWhisper` (`whisper_engine/post_meeting.rs`: a new whisper.cpp
state per piece, timestamps on, beam search 5 at temperature 0), and every
Whisper segment becomes a row with its own start and end. A segment without
duration joins its neighbour, because diarization clears the label of a row
without duration; one that repeats the words of the segment before it is
dropped, since a looping decode often goes on with zero-length or past-the-end
segments. Three or more consecutive rows with the same words merge
(`merge_repeated_rows`); two stay, as one speaker can answer twice. A
retranscription sorts the rows of both tracks by start, with their speaker
hints, before saving them (`in_time_order`), since a piece adds all its rows
before the next piece. Diarization then labels these sentence-sized rows by
overlap as before, and a rerun still changes labels only. Parakeet keeps the
capped pieces and one row per piece. Both engines skip the same short or silent
pieces (`skip_reason`). With the language on Auto (`None` or `"auto"`; not
`"auto-translate"`), Whisper detects it once per retained track on up to 30 s of
the track's most energetic pieces (`detection_audio`, `detect_once`,
`detect_per_track`). It detects on each half of that audio and uses the
language for the whole track only when both halves give it with a probability
above 0.5 (`agreed_language`): the loudest stretch is not always speech, and
one confident misreading would otherwise fix the track. Otherwise the track
keeps per-call detection. Both loops check for
Cancel before the detection. A track whose speakers switch language mid-meeting
is then transcribed in one language. Retranscription and import run these
steps through the same functions: `post_meeting::speech` (the batch VAD),
`pieces` (start order, the 25 s cut) and `Pass` (the skip, the language, the
engine call and, for retranscription only, the silence-hallucination filter);
the measurement kit calls them too. Live transcription keeps its pieces and
calls; its decoding is greedy at temperature 0, and every Whisper call shares
its language mapping, thresholds and output wrap (`WhisperDecoding::call_params`,
see below). See [Whisper engine](#whisper-engine) for why and what was
measured, and [MEASURING_TRANSCRIPTION.md](MEASURING_TRANSCRIPTION.md) for
how to measure a change to this pass. Unit tests: `audio::post_meeting::tests`
(VAD cap per engine, pieces in start order with the 25 s cut, skips before an
engine call, the silence-hallucination filter, rows from Whisper segments,
merged repeats, time order, which settings detect once, detection audio,
threshold and agreement), `whisper_engine::decoding::tests` (the
decodings and shared parameters as whisper.cpp receives them, the language
mapping) and `audio::common::tests` (the cut at the quietest point, no cut in
a piece's trailing silence).

Known limits of the post-meeting Whisper pass:

- The English silence-hallucination filter in retranscription still judges a
  whole piece (its joined rows and its RMS), so a quiet "Thank you." that
  Whisper writes as the last segment of a longer piece stays as a row; with
  6 s pieces such a tail more often formed a piece of its own and was dropped.
- If Turbo closes a segment with a single timestamp and then ends the text
  before the piece ends, whisper.cpp treats the rest as silence and stops
  (`single_timestamp_ending`); so does a segment closed long after its last
  word. The rest of the piece is then lost. On the measured span the second
  form caused the four largest remaining losses (14–21 words); the first was
  seen only on joined test windows.
- On Auto, a track whose loudest 30 s are all music, a video's soundtrack or
  speech in another language can have both halves agree on the wrong language,
  and the whole track is then decoded in it.

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
text, vocabulary, Speakers, and Speech models: the *For this computer* card,
then the Parakeet and Whisper lists under a collapsed *All models*. Nemotron's
download lives on Speakers. Owners, data flow, tests and limits are in
[SETTINGS_UX.md](SETTINGS_UX.md).

### Speech models for this computer (#88)

Protocol picks one pair per computer: Parakeet live (on the Intel NPU, #66)
and Whisper Large V3 Turbo after meetings (its Intel GPU version on an Intel
GPU, else the Compressed copy). `lib/speech-choice.ts` decides the pair, the
device badges and the update offer for Settings and onboarding;
`speech_choice.rs` owns what must outlive the WebView: the Intel GPU version
as a model id of its own with its fallback to a regular copy, the choice made
by `openvino_download { choose }`, and the removal of the Compressed copy after
the Intel GPU version's first successful post-meeting pass. Owners, the
offer's conditions, the removal rule, the card's states and the tests are in
[MODEL_CHOICE.md](MODEL_CHOICE.md); the contract with #66 is
`ParakeetNpuStatus` (`parakeet_npu_status`, `parakeet-npu-status`,
`parakeet_npu_retry`, `openvino_runtime_download`).

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
  size; `Check::resume` re-reads a kept partial first (Parakeet, GGUF, Whisper). Diarization
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
| Linux x64 | `Microsoft.ML.OnnxRuntime` 1.24.4 (NuGet), its `runtimes/linux-x64` CPU build | `load-dynamic`, `binaries/onnxruntime/libonnxruntime.so` from the deb's or AppImage's resources |
| macOS arm64 | pyke's 1.31.0 CoreML build, downloaded by `ort` (`download-binaries`) | linked statically |

- `build/onnxruntime.rs` downloads the Windows and Linux archives and checks
  the size and SHA-256 of each archive and of every file it stages (Linux
  stages `libonnxruntime.so` and the license). Linux took the runtime from
  Microsoft's `onnxruntime-linux-x64-1.24.4` GitHub release until the
  `microsoft/onnxruntime` repository disappeared from GitHub in November 2026
  (#104); the NuGet package's linux-x64 library is that release's
  `libonnxruntime.so.1.24.4` byte for byte, so the staged library's pin did
  not change (the package's `LICENSE` has CRLF line endings).
  `tauri.windows.conf.json` and `tauri.linux.conf.json` bundle
  `binaries/onnxruntime/*`. Linux does not use ort's own binaries: their 1.31.0
  build needs glibc 2.38 (`__isoc23_strtol` and relatives), more than the
  `ubuntu-22.04` release runner has, and a CPU with AVX2; Microsoft's build
  needs glibc 2.27 and no AVX2.
- `onnx_runtime.rs` owns the process's only `ort` environment (rc.14 makes it
  explicit and allows one per process); every session is built from
  `onnx_runtime::environment()`, which must be the process's first ort call:
  ort loads a runtime on its first API call and would otherwise take
  `ORT_DYLIB_PATH` or the system library path. On Windows and Linux `ort::init_from`
  refuses a library older than API 24 and reports one that does not load
  (a malformed one, which ort asserts on, is caught), and the app logs
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
  to a reference transcript. Metal and CUDA keep it on fast tiers. Per stage
  (#78, live pieces of `fleurs-ru`, Turbo q5_0): flash attention doubles the
  encoder (833 ms per 30 s window instead of 447; ggml-vulkan's
  `FLASH_ATTN_EXT` takes 18 ms per layer, against 7 ms for the unfused
  `KQ`, softmax and `KQV`) and leaves the decoder as it is. whisper.cpp
  #3806 reports an AMD RDNA4 Vulkan driver crashing with it. ggml's Intel Xe
  flash attention kernels (whisper.cpp 1.9.5, and the prefill kernel still
  in review as llama.cpp #29357) engage only with an f16 mask, and Whisper's
  encoder and cross attention pass none: re-measure before turning it on
  after an update.
- On the CPU (whisper.cpp's default of 4 threads; the app's `max_threads` is
  still not applied) a 20-second clip took 197 s instead of 252 s with Large
  V3 Turbo Compressed and 10.5 s instead of 7.9 s with Base.
- whisper.cpp runs beam search only at temperature 0. Before #62 the live
  calls took their decoding from the hardware profile (`get_whisper_config`):
  beam 2 at temperature 0.2 on Windows, from beam 5 at 0.1 to beam 1 at 0.4 by
  tier elsewhere. Every one of these is above 0, so each live call was one
  sampling decoder (whisper-rs leaves `greedy.best_of` at -1 for
  `BeamSearch`), seeded per state, so repeatable. The live calls now decode
  greedily at temperature 0 on every tier (`WhisperDecoding::LIVE` in
  `whisper_engine/decoding.rs`; the hardware profile no longer has decoding
  fields). On the 6 s pieces of 20 minutes of a recorded meeting (Turbo q5_0,
  Vulkan, Intel Arc B390, language `ru`), WER against the long-form reference
  went from 0.297 to 0.293 and the calls took 162 s instead of 175 s (median
  call 652 ms instead of 692 ms); two runs gave identical text. Both decodings
  keep whisper.cpp's +0.2 temperature fallback; greedy keeps it on one decoder
  (`best_of` 1). Beam search 5 at temperature 0 measured 0.263 on the same
  pieces in about 11 % more time than the old decoding; the live calls do not
  use it, which keeps them on one decoder (see the KV-cache note below).
- Decoding without timestamps, as the live calls do, Large V3 Turbo puts more
  than 0.2 of its probability on end-of-text while the speech goes on, 12 to
  25 s into a window (#62). Forced through a reference transcript of 34 windows
  of 15–28 s from a recorded Russian meeting, it did so in 21, alike with q5_0,
  q8_0 and f16 weights, on Vulkan and on the CPU, in whisper.cpp 1.7.1 and
  1.8.3; Large V3 f16 in 4, each in the last few words. Beam ranking by mean
  log-probability, or sampling, then picks the end, and without timestamps
  whisper.cpp cannot resume: the rest of the window is lost. It is a property
  of the model, not a whisper.cpp or ggml bug. Live calls stay under the live
  VAD cap (3.5 or 6 s) and do not reach that region. The batch VAD inherited
  the 6 s cap from the VAD constructor (Actually Free `f4b2399` added it for
  live streaming: bounded buffers and online diarization), which kept the
  post-meeting pass short of it too, at the cost of words cut at the 6 s cuts.
- The post-meeting pass therefore decodes pause-bounded pieces with timestamps
  (`whisper_engine/post_meeting.rs`): the model closes segment after segment,
  and whisper.cpp continues from the last timestamp when a segment does not
  fit. On 20 minutes of the meeting (Turbo q5_0, Vulkan, Intel Arc B390,
  language `ru`), WER against a long-form Large V3 reference fell from 0.297
  (the pass before #62) to 0.270, and from 0.247 to 0.217 against a Large V3
  reference decoded one utterance at a time, in 112 s instead of 166 s. Turbo
  can still skip speech by closing a segment long after its last word: 4
  stretches of 14–21 words. Keeping the 6 s cap with timestamps measured 0.250
  but cut words at the cuts, brought back subtitle-credit hallucinations on
  short noisy pieces and took 196 s; pause-bounded pieces without timestamps
  measured 0.333. Beam search 5 at temperature 0 repeats its text on the same
  audio (a repeat run gave identical text), but only on a new state:
  whisper.cpp's beam draws its candidates from each decoder's sampler, not the
  top ones (`whisper_sample_token_topk`), and decoder 0's sampler is seeded
  only when a state is created, so a state shared between pieces would make a
  piece's text depend on the pieces before it (the same audio decoded twice on
  one state ended two segments 20 ms apart). Greedy at temperature 0, which
  takes the most likely token, was about as accurate and took 22 % less time but fell into a one-word repetition loop on one piece;
  sampling at 0.2 measured 0.286. Rows are Whisper's segments (median 6.9 s,
  at most 22 s on that span). On the system track of a second meeting with
  several remote speakers, 13 % of the rows contained another diarized speaker
  for at least 0.5 s, against 30 % of the 6 s rows, and the share of speech
  whose row label matched the diarization timeline was 0.935 against 0.932.
- With the language on Auto, whisper.cpp detects it in every call with one
  more encoder pass. With 6 s pieces this made a beam-5 pass 54 % slower and
  put 7 of 230 short or noisy pieces into English, Dutch or Turkish; detecting
  once per track took 2 × 0.6 s and gave the same text as a fixed `ru`. The
  track's language is used only above probability 0.5, so an unclear
  detection keeps per-call detection (`audio/post_meeting.rs`).
- Beam search with more than one decoder makes `whisper_full_with_state`
  grow the new state's KV cache to 7 decoder slots (beam 5 plus 2 against
  fragmentation: about 73 MB for Turbo, 587 MB for Large V3), once per piece.
  If the allocation fails, whisper.cpp frees the caller's state and returns -7
  (still so in whisper.cpp 1.9.5), and whisper-rs would free the state again
  on drop. `PostMeetingWhisper` leaks the state instead and decodes that piece
  greedily with one decoder, which never grows the cache. The leak also keeps
  the model loaded until the app restarts: a whisper-rs state holds a reference
  to its model context, so unloading or switching the model then frees
  nothing. The first -7 of an app session therefore makes every later
  post-meeting pass, of any model, decode greedily from its first piece until
  the app restarts (`BEAM_CACHE_FAILED`): a later pass would have less room for
  the beam's cache than the one that failed, and each failure would leak
  another copy of the model. The model is leaked at most once per app session,
  and the warning is logged once. The live calls' single decoder never grows
  the cache.
- **The live calls share one whisper.cpp state** (#78; `live_state` in
  `whisper_engine.rs`). A state holds the KV caches and the compute buffers
  of the conv, encoder, cross and decoder graphs, about 450 MB for Turbo on
  Vulkan; creating one took 23 ms and freeing it 62 ms of a 690 ms live call
  on an Intel Arc B390 (the post-meeting pass's 1761 ms piece: 98 ms).
  - Owner and user: `WhisperEngine` owns it; its only user is the live
    transcription worker (one worker) through
    `transcribe_audio_with_confidence`. The `whisper_transcribe_audio`
    command and the post-meeting pass keep a new state per call.
  - Lifecycle: the first live call makes it from the loaded context. It is
    freed when the transcription task's workers have finished
    (`release_live_state` at the end of `start_transcription_task`), when the
    model is unloaded or replaced (`unload_model`, `load_model`), and after a
    call that failed on it; the next live call makes a new one. A state holds
    its model context, so freeing the state is what lets an unload free the
    model. Lock order: the context, then the state.
  - Text: `no_context` (whisper.cpp's default) clears the past text before
    every call, and each call resets the KV cache, mel, results, language and
    token-timestamp state. Only decoder 0's sampler carries on; it draws only
    in the temperature fallback, so a fallback's text depends on the earlier
    fallbacks of the recording instead of on a seed of 0. On the 46 live
    pieces of `fleurs-ru` there were none, and the texts on a shared state
    were identical to those on new states.
  - The post-meeting pass keeps a new state per piece on purpose (see above):
    a shared one changed the text of 4 of 15 pieces, for 5.5 % of the time.
  - Measured against `main` on `fleurs-ru` (Arc B390, three interleaved
    runs each):
    - The kit's live setting: 694 → 608 ms per call and 9 % less package
      energy, with the same text and WER.
    - The live pace (a 6 s window every 6 s): 732 → 622 ms per call, and
      17.1 → 15.6 J per call above the pauses. After 5 s of idle a state
      costs 32 + 70 ms to create and free.
    - Back to back, the decoder on a shared state is 3–10 % slower per
      token, with the GPU time of its graph unchanged, so the cost is on the
      host. At the live pace it is not slower (3.87 against 4.03 ms per
      token).
- Every Whisper call's output wraps at 200 bytes (`max_len` counts bytes) only
  before a word (`split_on_word`); a byte wrap inside a Cyrillic word would
  split it in two.

The ignored test `an_installed_model_loads_and_transcribes` loads a model
(`PROTOCOL_WHISPER_TEST_MODEL`, read only) and transcribes a 16 kHz mono WAV
(`PROTOCOL_WHISPER_TEST_WAV`, optional `PROTOCOL_WHISPER_TEST_LANGUAGE`) on the
build's backend, through the live call and through `PostMeetingWhisper` (twice
on one pass, which must give the same rows). The live call runs three times:
twice on the shared state and once on a new one after `release_live_state`,
with the same text each time, and unloading the model must free the live
state. Windows Vulkan builds need a short cargo target dir
([BUILDING.md](BUILDING.md#build-from-source-windows)).

Where a live call's time goes, measured with the kit's
`measure::stages::whisper_stages` (#78;
[MEASURING_TRANSCRIPTION.md](MEASURING_TRANSCRIPTION.md#measurestageswhisper_stages)):

| Turbo q5_0, Vulkan, Intel Arc B390, 6 s pieces | ms per call |
|---|---:|
| state created / freed (before #78) | 23 / 62 |
| mel on the CPU | 26 |
| encoder (conv, 32 layers, cross) | 447 |
| prompt and 23 generated tokens (3.5 ms each) | 86 |
| sampling on the CPU, the rest of `whisper_full` | 46 |

The encoder's GPU time is the unfused attention (`KQ`, softmax, `KQV` over a
1500 × 1500 × 20 f32 score matrix per layer, 237 ms, bound by memory
traffic), the q5_0 weight matmuls (135 ms at 12–17 TFLOPS) and unfused
element-wise ops (60 ms). q8_0 and f16 weights take the same encoder time or
more (447, 472 ms) and a slower decoder (4.0, 5.3 ms per token). OpenVINO
GenAI with INT8 weights on the same GPU spends about 74 ms on the encoder and
3.6 ms per token (166 ms per call); the difference is ggml-vulkan's encoder
kernels, not the state or the decoder.

### ggml CPU baseline (#176)

ggml's CPU backend runs at every whisper.cpp model load, GPU or not
(`ggml_backend_cpu_device_get_extra_buffers_type` among others), so the
instruction set it is compiled for decides which CPUs can run Whisper at all.
ggml defaults to `GGML_NATIVE=ON`: `-march=native` with GCC, FindSIMD.cmake
with MSVC, i.e. the CPU of whichever runner builds the leg. The 1.0.0 RC's
runners had AVX-512, and the packaged Linux app died with SIGILL at the first
Whisper load on a Core Ultra without it (6191 zmm instructions, all in ggml;
the Windows exes had 4780, also all in ggml).

The x86_64 builds therefore set `GGML_NATIVE=OFF` and x86-64-v3
(`GGML_SSE42`, `GGML_AVX`, `GGML_AVX2`, `GGML_FMA`, `GGML_F16C`, `GGML_BMI2`
on, `GGML_AVX512` off), which `whisper-rs-sys` passes to CMake with every
other `GGML_*` variable: the Linux leg's job env (deb and AppImage),
`build-universal-windows.ps1` (CPU and Vulkan variants) and the updater-e2e
Windows and Linux jobs. AVX2 CPUs go back to Intel Haswell (2013) and AMD
Excavator (2015); CPUs without AVX2 are not supported, and the release notes
(`render-notes.mjs`) say so. `llama-cpp-sys-2` (llama-helper) needs nothing:
it sets `GGML_NATIVE=OFF` itself (unless `RUSTFLAGS` say `target-cpu=native`)
and passes only `CMAKE_*` on, and ggml's defaults without NATIVE are this
baseline; the RC's llama-helper had no zmm code on either platform. macOS
arm64 keeps NATIVE: its runner is the M1 baseline. `whisper-rs-sys` does
not rebuild when `GGML_*` change, so the rust-cache keys of those jobs are
bumped with them.

`scripts/release/check-cpu-baseline.mjs` checks the shipped executables
(unit tests: `scripts/release/test/check-cpu-baseline.test.mjs`). The Linux
leg runs it with `--no-evex` on both packages' `protocol` and `llama-helper`:
no instruction may use a zmm register or the EVEX encoding at all, since the
Linux executables have none outside ggml. `verify-windows-release.mjs` runs it
on `protocol.exe`, `protocol-vulkan.exe` and `llama-helper.exe` for zmm only:
an AVX-512 ggml always has zmm code, while about 18 EVEX xmm instructions
outside ggml are MSVC auto-vectorized loops (`vpmullq`, `vpminuq`) behind the
CRT's `__isa_available >= 6` check, which also appear in `protocol-mcp.exe`.
Locally a `--features vulkan` test binary built with these variables had no
EVEX instruction and loaded Large V3 Turbo on the Arc B390 and, with the
Vulkan drivers hidden, on the CPU of a Core Ultra X7 358H (no AVX-512).

Data in code (#216): MSVC keeps a switch's jump table of 32-bit RVAs in
`.text`, and in 1.0.0-rc.1 one table happened to decode as
`vblendmps %zmm18,%zmm15,%zmm21{%k3}{z}` and failed the Windows leg, though
only the version string had moved the layout. `excludeJumpTables` reads the
PE section headers and does not count a zmm decode that starts inside two
neighbouring RVAs into executable sections; the script's header explains why
a real zmm instruction cannot look like that. `zlib-rs`, the first suspect,
has its AVX-512 code behind a feature the tree does not enable. This rule is
proven on Windows only by the release dry run on `main`.

### Processor check at startup (#216)

`cpu_support.rs` checks CPUID and XCR0 for everything x86-64-v3 adds (AVX,
AVX2, FMA, F16C, BMI1/2, LZCNT, MOVBE and the v2 set) before any ggml code can
run, ggml's C++ static initializers included: `main.rs` expands
`cpu_check_before_static_initializers!`, which puts the check in the
executable's `.preinit_array` (Linux) or `.CRT$XCB` (Windows, ahead of the
`.CRT$XCU` initializers). The check is plain Rust: Cargo sets no
`target-cpu`, only ggml's CMake gets the `GGML_*` flags. On a processor that
lacks them it prints one message to stderr, shows it (`MessageBoxW`;
`kdialog` or `zenity` on Linux, KDE's first under KDE) and exits with 1.
On Linux it reads the environment from the loader's `envp`: `environ` is
still null in preinit functions (glibc bug 30424), and a dialog started
without `DISPLAY` and `WAYLAND_DISPLAY` shows nothing.

Tests: `cargo test -p protocol --lib cpu_support` fakes CPUID and XCR0
(Haswell, Sandy Bridge, a Pentium without AVX, a VM without ymm state) and
parses an `envp`. The real binary was run under `qemu-x86_64 -cpu
SandyBridge` on Linux, which showed the dialog; Windows only by build.

### Whisper on OpenVINO (Intel GPUs)

On Windows the Vulkan build runs Large V3 Turbo through OpenVINO GenAI's
`WhisperPipeline` when the model's OpenVINO companion and Intel's runtime are
installed and the GPU whisper.cpp would use is an Intel GPU OpenVINO lists
(#79); otherwise, and after a failed load, whisper.cpp runs as above. Since
#178 the Linux Vulkan build does too (the gates are
`cfg(any(windows, target_os = "linux"))`; the NPU and Authenticode stay
Windows-only). Read [OPENVINO_WHISPER.md](OPENVINO_WHISPER.md) (its
[Linux](OPENVINO_WHISPER.md#linux) section for what differs) before changing it.

- Linux (#178): Intel's `ubuntu22` `.tar.gz` (`runtime::extract_tar`, regular
  files only), the libraries opened by absolute path dependencies first
  (`genai::PRELOAD`, since they carry no RUNPATH), the offer by the GPU's PCI
  vendor in sysfs (`device::offer_by_address`), and Intel's OpenCL driver
  checked through the OpenCL loader's `.icd` files (`device::missing_driver`,
  `availability.driver`, shown under the Intel GPU row of For this computer).

- The device rule (`whisper_engine/openvino/device.rs`): OpenVINO runs only
  on the GPU whisper.cpp would pick, and only if it is an Intel GPU. The GPU
  is tied to OpenVINO's by PCI address when ggml-vulkan reports one, else by
  the Vulkan device name and type against OpenVINO's `FULL_DEVICE_NAME`
  (without its ` (iGPU)`/` (dGPU)` suffix) and `DEVICE_TYPE`, unique match
  only. The second path exists because ggml-vulkan reads the address from
  `VK_EXT_pci_bus_info`, which the Arc B390's Windows driver does not offer.
  Hybrid NVIDIA/AMD laptops keep whisper.cpp either way. Before the runtime
  is installed, `device::offer_for` decides whether Settings offers it: the
  vendor (0x8086) of the display adapters Windows lists under that GPU's name.
- `whisper_engine/openvino/`: `genai.rs` (the C API binding and its
  `API_LEVEL`, loaded by absolute path; it asks only the GPU plugin for
  devices, hands GenAI paths as ASCII or in the code page it reads them in,
  and points GenAI's tokenizer variable at the runtime's own copy),
  `device.rs` (the device rule and the offer), `mod.rs` (the process's one
  runtime load, the crash guard around loading, the GPU query and compiling,
  which a clean exit turns off,
  `OpenVinoWhisper`, its lifecycle, the model cache keyed by runtime version
  and model commit, the live and post-meeting calls, the piece trim,
  `availability`).
  `WhisperEngine` keeps the pipeline in `openvino` in place of
  `current_context`; `transcribe_audio*`, `PostMeetingWhisper::transcribe_piece`
  and `detect_language_with_probability` branch on it. The OpenVINO live
  calls never create #78's `live_state`; a load on either backend frees the
  other's model, and on OpenVINO also the live state.
- The runtime is not in the installer: the catalog's `runtimes` list pins
  Intel's archive and every file ([MODEL_CATALOG.md](MODEL_CATALOG.md#runtimes)),
  and `model_catalog/runtime.rs` installs a version atomically into
  `<data>/runtimes/openvino-genai/<version>/`, only from the host this build
  pins for it and with every library signed by Intel
  (`model_catalog/authenticode.rs`): the catalog is not signed.
- `model_catalog/openvino.rs`: the `openvino-ir` companion entries
  (`companion_of`, `runtime`), the one download that installs the runtime
  and the companion, removal, runtime updates and pruning (also at startup,
  `prune_at_startup` in `lib.rs`; all under one lock, `OPERATIONS`), the
  retry after a crash (`openvino_retry`), and `installed_companion` and
  `runtime_to_load`, which the engine asks; Settings offers the download
  in the For this computer card (`settings/ForThisComputer.tsx`, #88).
- #88: the companion is also a Whisper model of its own,
  `large-v3-turbo-openvino-int8`, listed by `discover_models`
  (`speech_choice::listed`) and loaded by `WhisperEngine::load_gpu_version`,
  which falls back to a regular copy from `companion_of` or fails with a
  message; `openvino_download` takes `choose` ([MODEL_CHOICE.md](MODEL_CHOICE.md)).
- Busy registry: the download holds `BusyReason::ModelDownload`, compiling the
  model `BusyReason::ModelCompile`.
- Settings: Local stack shows the OpenVINO device or the fallback reason
  (`get_local_stack_status`, `whisper.openvino`); `get_openvino_availability`
  decides whether the download is offered and, once the runtime is
  installed, names the device or the mismatch.

### Whisper on Vulkan in the Linux app

The Linux AppImage and deb are one build with `--features vulkan` (#176).
Whisper runs on a hardware Vulkan GPU (Mesa on Intel and AMD, NVIDIA's
driver) and otherwise on the CPU; Windows instead installs a CPU or a Vulkan
executable after its probe (below). `whisper_engine/vulkan.rs` holds both
parts:

- The loader. ggml-vulkan calls three Vulkan functions by symbol
  (`vkGetInstanceProcAddr`, `vkGetPhysicalDeviceFeatures2`,
  `vkCmdCopyBuffer`) and the rest through vulkan.hpp's dynamic dispatcher.
  `main.rs` defines the three (`export_vulkan_symbols!`) and forwards them
  to the system loader, so the executable, linked with
  `--as-needed`, has no `DT_NEEDED` on `libvulkan.so.1`: it starts without a
  Vulkan loader, and linuxdeploy, which follows `DT_NEEDED`, bundles none (the
  AppImage excludelist does not list `libvulkan.so.1`, so a linked loader
  would be bundled). The forwarder opens the system's `libvulkan.so.1` on its
  first call. Without one, or while the guard keeps the GPU off, it answers
  `vkEnumerateInstanceVersion` with `VK_ERROR_INITIALIZATION_FAILED` and
  everything else with `NULL`: `ggml_backend_vk_reg` catches the
  `vk::SystemError`, no Vulkan backend registers, and no driver code runs.
  The lib's test binary defines the same symbols (`cfg(test)` in
  `vulkan.rs`), so the tests and the measurement kit take this path too.
- The device. ggml-vulkan registers discrete and integrated GPUs and skips
  `VK_PHYSICAL_DEVICE_TYPE_CPU` devices (llvmpipe); with no GPU it registers
  none. `context_parameters` then turns `use_gpu` off
  (`acceleration::whisper_has_gpu`), the log says "CPU processing only" and
  `get_local_stack_status` reports `sttBackend` `CPU` for a loaded model, so
  Settings says "processor". `GGML_VK_VISIBLE_DEVICES=` (empty) keeps every
  device from ggml: the way to stay on the processor with a driver that
  works but misbehaves.
- The crash guard, `parakeet_engine::npu::guard`'s pattern with its own
  marker `<data>/runtimes/whisper-vulkan.attempt`, around the steps where a
  broken driver crashes the process: `look_for_devices` (the first
  `ggml_backend_dev_count`, which creates the instance and loads the
  drivers; called before every whisper.cpp context, also the model check's in
  `model_catalog/service.rs`), `load` (a GPU context: device, buffers,
  weights) and `first_run` (the first inference of each model loaded on the
  GPU, which compiles the shaders ggml needs for its operations and weight
  type on demand; `load` rearms it; live, post-meeting, `transcribe_audio`,
  language detection). A marker found at start keeps the loader closed: Whisper runs on
  the processor and `whisper.gpuStopped` carries the reason; For this computer
  shows it on the Whisper row with Try again (`whisper_gpu_retry`), which
  removes the marker and takes effect at the next start, since ggml lists its
  devices once per process. `RunEvent::Exit` and the updater's exit remove a
  marker a clean quit leaves (`set_closing`).
- Build and packaging (`release-build-linux.yml`): the LunarG SDK 1.4.309.0
  that Windows builds with (headers and `glslc`; Ubuntu 22.04's are 1.3.204),
  and `-lvulkan` against its loader through `LIBRARY_PATH`. `tauri.deb.conf.json` adds `libvulkan1` to
  `Depends`. The leg fails if the deb does not depend on it, if the executable
  links `libvulkan`, if it lacks ggml-vulkan, or if the AppImage carries a
  Vulkan loader.

Tests: `whisper_engine::vulkan::tests` (the marker, a retry, a clean quit, a
panicking step, the answers without a loader),
`whisper_engine::vulkan::linux::tests::the_first_inference_of_each_gpu_model_is_guarded`,
`acceleration::tests::a_registry_without_gpus_has_no_gpu_device` and
`a_context_without_the_gpu_reads_as_cpu`, and the For this computer test in
`SpeechSettings.test.tsx`. On this laptop both binaries have no `DT_NEEDED`
on `libvulkan.so.1` (`readelf -d`), and a driver that crashes when the loader
first calls it (a fake ICD through `VK_DRIVER_FILES`) took the measurement
kit down once with SIGSEGV in "looking for the graphics card"; the next run,
with the same driver, kept the loader closed and transcribed on the CPU.

Measured on this laptop (Core Ultra X7 358H, Intel Arc B390 with Mesa 26.2
Vulkan, Kubuntu 26.10; the owner was using it, load average 2–5.5) with
`measure::transcribe_settings` on `fleurs-ru` (`ru`, `post-meeting,live`,
the order swapped every second run), three runs per build, main's CPU build
against this branch's Vulkan build; medians with the range, in seconds:

| Model | Setting | CPU | Vulkan | WER CPU → Vulkan |
| --- | --- | ---: | ---: | --- |
| Large V3 Turbo q5_0 | post-meeting | 222.1 (216.4–249.8) | 18.5 (17.8–18.6) | 0.064 → 0.064 (26/1/1 both) |
| Large V3 Turbo q5_0 | live | 619.3 (610.0–624.4) | 33.0 (32.8–33.8) | 0.108 → 0.108 (27/10/10 both) |
| Small | post-meeting | 66.6 (66.5–67.0) | 16.9 (16.8–17.4) | 0.145 → 0.143 (31/32/0 → 30/32/0) |
| Small | live | 135.4 (132.3–136.3) | 12.6 (12.5–12.8) | 0.228 → 0.228 (40/45/14 both) |

Each build gave the same text in all three runs; the one word Small's
post-meeting pass gets right on Vulkan is the backends' different float
arithmetic, not a change in decoding. The CPU build uses whisper.cpp's
default of 4 threads (the app's `max_threads` is not applied, see above).
Remaining limits: the
Linux release leg builds the packages only on `main`, and its runner has no
GPU, so the GPU path is verified on this laptop only (Intel Arc B390, Mesa);
no AMD or NVIDIA machine, no hybrid laptop; the guard covers each GPU
model's first inference, not later ones.

### Parakeet on the Intel NPU

On Windows with an Intel NPU, Parakeet v3's encoder runs on the NPU through
OpenVINO's C API from the same runtime (#66); the preprocessor and the decoder
stay on ONNX Runtime's CPU provider. Read [PARAKEET_NPU.md](PARAKEET_NPU.md)
before changing it.

- `parakeet_engine/npu/`: the C API binding (`openvino.rs`), the encoder on the
  static 608-frame shape (`mod.rs`), the NPU found without the runtime by its
  PnP device class (`detect.rs`), the crash guard of its native steps with a
  marker of its own (`guard.rs`), and the state for Settings with the one-time
  preparation, the cache under `cache/openvino/parakeet-npu/`, the commands
  `parakeet_npu_status`/`parakeet_npu_retry` and the `parakeet-npu-status`
  event (`state.rs`, the contract with #88). The preparation holds
  `BusyReason::ModelCompile` and waits while a recording or another engine job
  runs; a model load while `ready` takes the NPU, any failure the processor.
- `parakeet_engine/chunking.rs`: the windows the static shape needs (#80's
  feed B: stretches of touching pieces, windows every 3.5 s snapped to a pause,
  the retry, the anchor merge, words assigned to their pieces) and the live
  variant, which holds a capped piece's last second for the next piece. A
  junction drops a call's word only when the other call has a word starting
  within 320 ms of it or overlapping its tokens' frames, so the other call's
  words in a span TDT left empty in one window stay.
- The paths: `Pass::windows_over` (import and retranscription) decodes each
  stretch whole on the NPU; the live worker keeps a `chunking::Live` per
  source (`audio/transcription/parakeet_live.rs`, which also shows held words
  whose continuation was lost as rows of their own) and passes the VAD's cap
  flag (`SpeechSegment::capped`, `AudioChunk::capped`); `ParakeetModel` keeps
  the NPU encoder and builds its CPU encoder only on a fallback. The processor
  and Labs paths are unchanged.
- The runtime: the catalog pins the NPU plugin and the ONNX frontend;
  `runtime::complete_into` adds them to an older install of the same version
  while it is loaded, and `openvino_runtime_download` installs or completes the
  runtime alone. On a PC with an NPU the runtime stays without a Whisper
  companion while v3 is installed or downloading; removing v3 or the runtime
  removes the NPU cache.

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

The MCP server for AI agents (`protocol-mcp.exe`, #8) can be running when an
update installs, often with Protocol closed: `Protocol_MoveRunningServerAside`
in the pre-install hook checks that Protocol is closed (the template's
`CheckIfAppIsRunning`, so its Cancel or a failed kill leaves the server alone),
then renames the installed copy to `protocol-mcp.exe.old-<n>`, so the new file
can take its name and a server an agent starts during the file copy finds no
file to hold. Reaching the post-install hook, not the file name, says the copy
is over: it deletes the moved copy unless it runs (or renames it back if the new
file was skipped), and `.onInstFailed` renames it back over whatever holds the
name when the install aborts first. The uninstall
hook stops this install's copies by full path and deletes them. See
[MCP_SERVER.md](MCP_SERVER.md).

`node frontend/scripts/verify-windows-release.mjs [dist]` checks the output
without installing: `SHA256SUMS.txt`, the NSIS archive (7-Zip; `SEVEN_ZIP`
overrides the path), the exact variant and runtime sets (no CUDA files), that the
bundled `protocol.exe` does not import `vulkan-1.dll` while the Vulkan build
does, the `nsis` marker on both, no AVX-512 (zmm) code in the two builds and
llama-helper ([ggml CPU baseline](#ggml-cpu-baseline-176)), and that ffmpeg, llama-helper, protocol-mcp, ONNX Runtime and
the notices (`parakeet-rs-LICENSE.txt`, `THIRD_PARTY_MODELS.txt`) equal the
staged files. A local warm build took about 8 minutes and produced a 118 MB
installer (upstream's universal installer with CUDA was 674 MB).

### Releases

Releases are built by `.github/workflows/release.yml`, never locally; the
procedure, dry runs and the `release` environment are in
[WORKFLOWS_OVERVIEW.md](../.github/workflows/WORKFLOWS_OVERVIEW.md). Pull
requests run only `pr-checks.yml`; every push to `main` that changes more than
documentation also runs this workflow as a dry run (#65); `updater-e2e.yml`
runs only by hand, before a release.
Data flow:

1. A release PR runs `scripts/release/bump-version.mjs <version>`: the version in
   `tauri.conf.json`, `frontend/src-tauri/Cargo.toml`, `Cargo.lock` and
   `frontend/package.json`, and `## Protocol <version> — <date>` in `CHANGELOG.md`.
2. Once the merged commit's `release.yml` run and a manual `updater-e2e.yml`
   run on it are green apart from their macOS jobs, which gate nothing (#164), the owner
   pushes the tag `v<version>` on that commit.
   `validate-release.mjs` checks the tag format, that the commit is on
   `origin/main`, the version files, the CHANGELOG section (it becomes the notes),
   the published releases (no duplicate, above every non-draft release whatever
   its prerelease flag, so a release taken off Latest keeps counting), the updater
   configuration and the locked tauri-cli's `--app-version` support, and
   `check-migration-checksums.mjs --source git` the migration table.
3. `pr-checks.yml` runs as a reusable workflow, then the legs
   `release-build-{windows,macos,linux}.yml` build, test and smoke-test, and each
   uploads a `leg-<platform>` artifact with its `SHA256SUMS.txt`. Legs have no
   secrets.
4. `draft` (environment `release`, tag runs only) needs only the Windows and
   Linux legs and runs `assemble-release.sh` on `leg-windows` and `leg-linux`:
   checks the artifacts, signs the two updater payloads with the production key
   and `--app-version` (`sign-payloads.sh`), verifies the signatures against
   `plugins.updater.pubkey` (`verify-updater-signature.mjs`), writes `latest.json`
   (`make-latest-json.mjs --platforms windows,linux`), `SHA256SUMS.txt` and the
   notes (`render-notes.mjs`, whose macOS row says the download follows), then
   attests the installers and creates the draft; `check-release-assets.mjs`
   compares the uploaded assets with the local files. Dry runs run the same
   script in `preview` with a throwaway key.
5. `join-macos` (environment `release`, tag runs only) follows `build-macos` and
   `draft`, draft or published: `join-macos.sh` signs and verifies the macOS
   bundle with `sign-payloads.sh`, `merge-macos.mjs` merges the darwin keys into
   the release's `latest.json` and the macOS lines into its `SHA256SUMS.txt` and
   renders the body again unless it was edited by hand; the job attests and
   uploads the macOS files (feed last) and checks the release, publicly once it
   is published. Re-runs replace only the macOS entries. Dry runs do the same in
   `preview-macos` against the `release-dry-run` artifact.
6. The owner publishes, with or without macOS; `release-published.yml`
   (`check-published-release.mjs`) checks the public assets of the platforms the
   release has (Windows and Linux required, macOS whole or not at all), the feed
   and `/releases/latest`.

The feed has `windows-x86_64-nsis` and `windows-x86_64` (both the setup),
`darwin-aarch64-app` and `darwin-aarch64` (`protocol-macos-arm64.app.tar.gz`,
from the moment macOS has joined; before that macOS installs get `noPlatform`)
and `linux-x86_64-appimage`, and deliberately no `linux-x86_64` or deb key: a deb
install finds no entry and gets #31's download link instead of an AppImage.
Signatures carry the version (`signer sign --app-version`, tauri-cli 2.12 from
#33); `verify-updater-signature.mjs` checks it. Until #31's configuration is in
`main`, dry runs warn about it and the macOS leg adds a throwaway updater
configuration so the `.app.tar.gz` is still built; tag runs fail.

**Linux packages.** The Linux leg runs `tauri build` twice (#100). Tauri
installs every `externalBin` entry as `/usr/bin/<name>`, and `/usr/bin/ffmpeg`
belongs to the distribution's `ffmpeg` package, so a deb carrying the pinned
ffmpeg does not install where that package is. The deb is therefore built with
`--config src-tauri/tauri.deb.conf.json`, which leaves ffmpeg out of
`externalBin` and adds `ffmpeg` to `Depends`. `audio/ffmpeg.rs` looks next to
the executable first, so `/usr/bin/protocol` runs the distribution's
`/usr/bin/ffmpeg`. `Depends` names no version: every option the app passes
(AAC in MP4 with `+faststart`, the concat demuxer with `-c copy`, decoding to
PCM, the waveform's `f32le`) is in ffmpeg 4.4 of Ubuntu 22.04, the oldest
system the leg builds for. The AppImage keeps the pinned ffmpeg from
`build/ffmpeg.rs` and is built second, from the plain config. The leg fails if
the deb carries `usr/bin/ffmpeg` or does not depend on `ffmpeg`, or if the
AppImage lacks its own. The config is compiled into the binary, so the two
packages hold separate builds of the same commit. A local
`tauri build --bundles deb` without that `--config` still packs the pinned
ffmpeg. Both builds take `--features vulkan`, and the deb also depends on
`libvulkan1` ([Whisper on Vulkan in the Linux app](#whisper-on-vulkan-in-the-linux-app)).

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
A database carried to the other platform opens there (#121):
`DatabaseManager::run_migrations` answers a mismatch in a historical migration
by rewriting each stored checksum that is exactly the other platform's released
one to this build's (`accept_other_platform_checksums`, tests
`opens_a_database_made_by_the_other_platform` and the two after it), as it
already repairs the people migration; any other mismatch stays an error. A
database that still does not open no longer ends the process at startup: native
logs it and leaves the database unset, and the window's startup screen shows
native's reason with Retry. Verified with the owner's Windows database on Linux.
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
CPU-only on Windows and Linux; on Windows the Vulkan/CPU choice happens at
install and update time, not at launch (Linux decides at launch, see
[Whisper on Vulkan in the Linux app](#whisper-on-vulkan-in-the-linux-app)).

### Fork identity and updates

Protocol is a fork of Meetily – Actually Free with its own identity, so it can run
beside an installed upstream build without sharing state:

| Surface | Value | Owner |
| --- | --- | --- |
| Bundle identifier, Windows AUMID | `io.github.vmedvedevpro.protocol` | `tauri.conf.json`, `windows_app_identity.rs` |
| Product name, install folder | `Protocol`, `%LOCALAPPDATA%\vmedvedevpro\Protocol` | `tauri.conf.json`, `windows/installer.nsi` (`INSTALLDIRNAME`, a `; Protocol:` change to Tauri's stock template) |
| Installer registry key | `HKCU\Software\vmedvedevpro\Protocol` (install folder, `BackendOverride`) | `bundle.publisher` + product name (stock `MANUPRODUCTKEY`); `windows/installer-hooks.nsh` |
| Uninstall entry | `HKCU\…\Uninstall\io.github.vmedvedevpro.protocol` | `windows/installer.nsi` (`UNINSTKEY`, a `; Protocol:` change to Tauri's stock template) |
| Fallback data root | OS data dir `/vmedvedevpro/Protocol` | `paths.rs` (`FALLBACK_PUBLISHER`, `FALLBACK_APP_NAME`) |
| Default recordings folder | `protocol-recordings` | `audio/recording_preferences.rs` |
| Cargo package and executable | `protocol`, `protocol.exe`; installer variants `protocol-vulkan.exe`, `protocol-vulkan-probe.exe` | `src-tauri/Cargo.toml`, `build-universal-windows.ps1`, `windows/installer-hooks.nsh` |
| Release assets | `protocol-windows-x64-setup.exe`, `protocol-macos-arm64.{dmg,app.tar.gz}`, `protocol-linux-x86_64.AppImage`, `protocol_<version>_amd64.deb` | `scripts/release/release-lib.mjs` |
| App, installer and tray icons | the recording ring (#120); the tray's in one colour, with a dot while recording | `frontend/scripts/build-icons.mjs` draws `src-tauri/icons/`; `src-tauri/src/tray/icon.rs` switches the tray's ([ARCHITECTURE.md › Branding assets](../ARCHITECTURE.md#branding-assets)) |

On Windows the installer writes the identifier to its shortcuts as their
AUMID, and `windows_app_identity.rs` binds the process to the same AUMID
before any window opens, so the taskbar groups the running window with a
pinned shortcut. Protocol shows no desktop notifications
([#126](https://github.com/vmedvedevpro/Protocol/issues/126)): the toast
registration under `HKCU\Software\Classes\AppUserModelId` that earlier
versions wrote stays unread, as does `notifications.json`.

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
| `tray.rs`, `quit.rs` | Check for Updates, the available or ready version, Restart to Update; Quit through `quit::request`, which saves a running recording first, asks about other busy work, and then calls `updater::quit_app` |
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
- Notifications (the rest went when
  [#126](https://github.com/vmedvedevpro/Protocol/issues/126) removed desktop
  notifications):
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
  detection still starts at launch and follows its setting (turned off since
  #102; see Labs below).
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

Changes to transcription and speaker labels are measured with the kit in
[MEASURING_TRANSCRIPTION.md](MEASURING_TRANSCRIPTION.md) (#75): ignored test
commands in `src/measure/` (test builds only) run the post-meeting pass, the
live Whisper call, Parakeet and the row labelling on a recording and write
JSON; `scripts/measure/` scores it in Python against a reference (WER, CER,
lost words, loops, hallucinations, speaker agreement); a fetch script builds a
public FLEURS fixture. The commands run the post-meeting pass's own functions
(`post_meeting::speech`, `pieces` and `Pass`, which retranscription and import
call too) and reach the rest through a few `pub(crate)` seams:
retranscription's source finder (`find_audio_file`,
`find_retranscription_sources`), the live worker's skip rule (`peak_level`,
`is_digital_silence`), `diarization::diarize_track_wavs` and `row_speakers`
(the calls on a microphone and a system track with their merged timeline, and
the row labelling `diarize_meeting` applies), the reference call
`WhisperEngine::reference_text` beside the pass's Whisper call, and
`load_model_in_place` on both engines, which opens a model without the
integrity markers `load_model` writes beside it. `reference_text` and
`load_model_in_place` are test-only (`#[cfg(test)]`), as are
`Pass::whisper_decoding` and `PostMeetingWhisper::decoding`, which the kit
records per piece.

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
opens first. The tray's Start emits `request-recording-toggle` to the main
window (#110,
[UI_ARCHITECTURE.md › Tray](UI_ARCHITECTURE.md#tray)). Topic extraction remains heuristic and
depends on a recognizable Key Topics heading or legacy section. Verification
covers frontend/native builds and the Windows installer payload; a local installer
is not a published release.

### Recording playback (#121)

`api_get_meeting_audio` (`api/api.rs`) finds a meeting's playback file and adds
its folder to the asset protocol scope; the meeting screen's `<audio>`
(`frontend/src/features/meetings/meeting/player.ts`) plays it from
`audioSource` in `frontend/src/api/meetings.ts`. On Windows and macOS that is
the asset protocol (`convertFileSrc`), which WebView2 and WKWebView stream with
byte ranges. WebKitGTK's media player accepts only blob, data, file, http and
https URLs (`isProtocolAllowed` in WebKit's `GStreamerCommon.cpp`) and fails
`asset://` with a FormatError before any request, so on Linux the reply also
carries `playbackUrl` from `recording_stream.rs`: a loopback HTTP server bound to
127.0.0.1 that serves only files native registered, each under a random 256-bit
token, with Range support, at most 32 connections at once; only Linux's CSP
(`tauri.linux.conf.json`) adds `http://127.0.0.1:*` to `media-src`.
WebKitGTK copies a streamed recording into an unlinked, 0600 temp file in
`/var/tmp` while its player exists (GStreamer's download buffering), so memory
stays flat for long recordings. Verified on WebKitGTK 2.52.6 under Xvfb with
WAV, M4A and a two-hour AAC `audio.mp4` (playing, and seeking to 1:56:00);
`recording_stream::tests` cover the ranges, unknown tokens and paths. Whether a
meeting has audio comes from native, not from playback: a recording the WebView
cannot play only switches the player off.

The deb plays through the system's GStreamer. The AppImage's AppRun lets
GStreamer load plugins only from the image (`GST_PLUGIN_SYSTEM_PATH_1_0`), so
the image carries them: `bundle.linux.appimage.bundleMediaFramework` in
`tauri.linux.conf.json` runs linuxdeploy-plugin-gstreamer, which copies the
files of `GSTREAMER_PLUGINS_DIR`, their libraries and the plugin scanner, and
writes the AppRun hook that points GStreamer at them. The Linux leg fills that
directory with the player's plugins only (`scripts/release/appimage-gstreamer.mjs
stage`, the list with what each is for): playbin and its conversion elements,
autoaudiosink with pulsesink (also PipeWire through pipewire-pulse; pipewiresink
has rank none and is never picked) and alsasink, and the containers and decoders
of recordings (AAC in MP4: qtdemux, aacparse, faad) and of the import formats
WAV, MP3, FLAC, OGG and WebM (Vorbis, Opus). WMA, and codecs other than these
inside MKV, do not play. A build without them had no autoaudiosink, and
WebKitWebProcess aborted as soon as a meeting opened (the first 1.0.0 RC). The
leg fails when the image lacks a listed plugin or the scanner, or when the
hook points elsewhere (`appimage-gstreamer.mjs check`, tested in
`scripts/release/test/appimage-gstreamer.test.mjs`). When neither pulsesink
nor alsasink opens (no sound server, no device), autoaudiosink falls back to a
fakesink, so the player still loads and plays, silently.

Meetings carried over from another computer keep the absolute `folder_path`
they were saved with (a `C:\…` path on Linux). When that folder is gone,
`api_get_meeting_audio` looks for a folder of the same name in the current
recordings folder (`meeting_folder.rs`) and, when there is one, writes its path
back to `meetings.folder_path`, since retranscription, speakers, the summary
and Open recording folder read that column too; otherwise it reports
`missingFolder` and the player says "The recording isn't where it was saved"
with the folder, not "No audio was saved". A recordings folder setting that is
not an absolute path on this OS falls back to the default folder on load
(`preferences_from_store_value`, not written back). Tests:
`meeting_folder::tests` and
`another_systems_recordings_folder_falls_back_to_the_default`; checked on Linux
with a `C:\…` folder path and a `C:\…` recordings folder.

### AI agents: the MCP server (#8)

`mcp-server/` (`protocol-mcp`) serves the meeting library to AI agents over
MCP on stdio, read-only, while Settings > AI agents (`AgentAccessSettings.tsx`,
`agent_access.rs`) holds the off-by-default switch and the commands that start
it; `claude_desktop_extension.rs` builds the Claude Desktop bundle. The Ctrl+K
search, the summary text and the switch file live in the shared
`meeting-library/` crate, so the app and the server answer the same way;
both pools register its `unicode_lower` SQL function (`sql.rs`), which lets the
search match capitalised Cyrillic in any case. The
server never writes, keeps each tool call under one second of statements so the
app's commits are not held, and answers `Open Protocol once` for a database it
cannot read safely. Data flow, limits, packaging and the update path:
[MCP_SERVER.md](MCP_SERVER.md).

### Speaker colors in transcripts

In the old UI (`162e8be`), `speakerUtils.ts` supplies the shared dot/text
palette for the live and post-call virtualized transcript, the live speakers
list, the person card and the identify dialog. A named person is drawn in their avatar's colour (`colorForName`),
so they look the same in the transcript, the meeting header and their contact
page; their transcript bubbles take a faint wash of it (`.af-speaker-bubble`).
Unnamed voices ("Speaker 2") get palette slots by first-spoken meeting order, so
they stay apart until identified; `You` uses the theme accent. The palette has
eight slots, so meetings with more than eight unnamed voices reuse colors.

### Themes (#96)

`frontend/src/styles/themeMode.ts` owns the theme mode; the rules are in
[UI_ARCHITECTURE.md](UI_ARCHITECTURE.md). The preference (`light`, `dark` or
`system`, the default) lives in localStorage under `meetily_theme` as a bare
string, which the main window and the minibar share, so a `storage` event
repaints the other window (`AppThemeProvider`). Values saved before #96 map on
read: Midnight and Charcoal to `dark`, Vanilla to `light`; a missing or
unknown value reads as `system`. The palettes are the light and dark themes in
`src/styles/theme.ts`. The boot script in `frontend/index.html` sets
`color-scheme` before the bundle runs with the same rules as `readThemeMode`
and must stay in step with it.

`system` reads `prefers-color-scheme`, which under Tauri reports the window's
theme, not the OS one. So the windows start with no forced theme
(`tauri.conf.json` and `tauri.windows.conf.json` set none), `AppThemeProvider`
calls `setTheme(null)` for `system` and `setTheme('light' | 'dark')`
otherwise (`setWindowTheme` in `src/api/window.ts`), and on Windows Tauri
passes each OS switch (tao's `WM_SETTINGCHANGE` handling emits
`ThemeChanged`) on to WebView2's preferred color scheme, where
`useResolvedTheme`'s media query listener picks it up. wry sets that scheme on
the WebView2 profile, which both windows share, so the last window to change
its theme sets it for both; while the preference is `system` neither window
has a forced theme, so they agree.

`src/styles/themeMode.test.tsx` checks the mapping of saved values and the
resolution, and `src/styles/themeBoot.test.ts` that the boot script paints
what the module would. The browser
preview was checked with emulated `prefers-color-scheme`. The OS switch in the
desktop app rests on tauri-runtime-wry 2.12.3 and tao 0.37.2 as read in their
source, not on a run in the app; on Linux the media query follows what
WebKitGTK reports and was not checked.

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

**Meeting detection is turned off** (#102) because it kept repeating its
prompt. Each scan returns the first process whose name matches, from a
`sysinfo` `HashMap` with a new random order every time; when one app runs
several matching processes (`zoom` and `zoomwebviewhost`), another one can come
first, the monitor sees a new `(app, process, active_media)` and emits
`meeting-detected` again, every 15 seconds. Without the Windows
microphone/camera signal, an idle app in the tray also counts. `AVAILABLE` in
`meeting_detection.rs` keeps the monitor from starting whatever
`meeting_detection.json` says, and `MEETING_DETECTION_AVAILABLE`
(`lib/meeting-detection.ts`) hides Settings > Meeting detection (old links open
General) and Labs > Meeting automation, which only acts on detection's events.
The code, the saved settings and the `layout.tsx` listeners stay; turning
detection back on after a fix means flipping both constants. #6 waits for that.

From `frontend/`, the frontend checks are `pnpm run lint`, `pnpm test` (Vitest
runs every test file in one invocation), `pnpm run build` and
`pnpm run build-storybook`, as CI's `pr-checks.yml` runs them. Where tests live
and how they use the mock IPC is in
[UI_ARCHITECTURE.md › Tests](UI_ARCHITECTURE.md#tests).

```text
pnpm run lint
pnpm test
pnpm run build
pnpm run build-storybook
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

Do not run `pnpm run build` concurrently with native commands embedding
`frontend/out`. When using pnpm in this environment,
`PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false` avoids the known store-layout
issue.

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
