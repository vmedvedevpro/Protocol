# Frontend 2.0 parity inventory

What the old Next.js frontend does, item by item, and which Frontend 2.0 task
([epic #123](https://github.com/vmedvedevpro/Protocol/issues/123)) carries it
into the new UI, or why it is dropped. Written for
[#107](https://github.com/vmedvedevpro/Protocol/issues/107). How the new UI is
built, and the rules each task follows, is in
[UI_ARCHITECTURE.md](../UI_ARCHITECTURE.md).

- Source: `frontend/src` on `main` at `162e8be`, with the native side
  (`frontend/src-tauri/src`) read where the UI depends on it. File paths in
  the tables are relative to `frontend/src/` unless they name the native side.
- Design: the design canvas (the link is in each task brief; this
  repository is public), page *Protocol* (`app`), its notes (the one checked
  against the code and the one listing what was removed) and artboards.
- The rows were collected with scripts over the source (every `invoke`,
  `listen`, `localStorage`, `sessionStorage`, plugin-store and IndexedDB call),
  then read where the purpose was not obvious. The command list matches the
  native `generate_handler!` list: all 217 invoked commands are registered;
  `open_database_folder` and `openvino_remove` are registered but the old UI
  never calls them.

Owner tasks: #106 scaffold, `src/api`, mock IPC, theme · #108 UI primitives ·
#109 Ring and level meters · #110 window shell (chrome, keep on top, routes,
hotkeys) · #111 notes editor · #112 recording (session, recording window,
live transcript, processing after Stop, transcript recovery) · #113 meetings
list and meeting screen · #114 settings simple mode, General, Recording ·
#115 first launch · #116 minibar · #117 settings AI, Advanced and subpages ·
#118 search and person · #119 dialogs · #120 app and tray icons · #121
real-app QA · #122 merge into main.

Dropped by the owner: the AI chat (`ChatThread`), the Contacts and Groups
pages (groups become folders in the meetings list; a person opens from search
or a name), meeting detection and auto-record. Also dropped on 2026-11-24: the
recording disclosure notice, desktop notifications (#126 removes them
natively), bulk actions with the library's date filter and sort order, and the
CUDA notice.

## Decisions

The owner settled every open question on 2026-11-24; the affected rows say
"owner decision 2026-11-24". The recording disclosure notice was dropped the
same day.

1. **Crash report dialog:** kept, as a sheet at startup (#110).
2. **Global download panel:** replaced by one status line in the bottom bar
   while any download runs; a click opens Settings › Speech models (#117; the
   line sits in #110's bar).
3. **"Summarize so far":** kept, through `ask_live_assistant` (#112). It
   takes no UI activity lease: while recording, the `recording` busy reason
   covers it. Native `ask_live_assistant` holds no busy reason of its own today
   (`live_assistant.rs`); if an answer can outlive Stop, #112 adds
   `let _busy = busy::hold(BusyReason::Summary);` to it. Native `UiActivity`
   knows only `recordingSave` and `postCall`, and an unknown name rejects the
   whole `updater_set_ui_activity` call.
4. **First launch** downloads Parakeet and Whisper Large V3 Turbo in the
   background (#115) and asks how summaries are written: the built-in model
   `builtin_ai_get_recommended_model` picks, on Install; a provider with the
   user's key; or later (#123).
5. **Default summary template:** #117 adds a stored default and the native
   part so the automatic summary uses it instead of the `daily_standup`
   fallback.
6. **Bulk actions, date filters and sort order:** dropped; a person's
   meetings are on the person screen (#118).
7. **Folder for a new recording:** a picker on the folder in the recording
   header (#112).
8. **CUDA notice:** dropped.
9. **Window size:** the main window opens at 460×700 and stays resizable;
   #110 changes `tauri.conf.json`.
10. **Desktop notifications:** dropped entirely: the recording started and
    stopped notifications and their settings, `show_simple_notification`, the
    audio route warning's system notification (the warning stays in the app,
    #112), and the Windows toast with its "Start recording" button and
    `start-recording-from-notification`. #126 removes them natively.

## Routes and windows

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `/` recorder: home backdrop, live session, record card | route | `app/page.tsx` | #112 | The design splits it: Home is the meetings list (#113), Record opens the recording window (#112). It also hosts transcript recovery and the recorder dialogs. |
| Home backdrop: clock, "Up next" from group schedules, open action items | route | `components/home/HomeDashboard.tsx`, `lib/schedule.ts` | dropped | Design: Home is the meetings list; schedules belonged to groups. |
| `/meetings` library | route | `app/meetings/page.tsx` | #113 | Merged into Home. Its bulk actions (move, export, delete), date filter and sort order are dropped (owner decision 2026-11-24); its contact filter (`?person=<id>`) is the person screen's meeting list (#118). |
| `/meeting-details?id=…&source=recording` | route | `app/meeting-details/page.tsx`, `page-content.tsx` | #113 | `source=recording` starts processing after Stop (#112). |
| `/person?id=…` | route | `app/person/page.tsx` | #118 | Opens from search or a name. |
| `/contacts` | route | `app/contacts/page.tsx` | dropped | Contacts page dropped by the owner. |
| `/groups`, `/groups?id=…` | route | `app/groups/page.tsx`, `components/groups/*` | dropped | Groups become folders in the meetings list (#113). |
| `/settings?section=…` | route | `app/settings/page.tsx` | #114 | Sections `general`, `recording`, `transcription`, `summaries`, `agents`, `detection`, `local`, `labs`, `about` map onto General, Recording, AI, Advanced (#114, #117). The tray sends `/settings` and `/settings?section=about`. Since #114 a section id turns Advanced on, and `about` lands on General › Updates ([UI_ARCHITECTURE.md › Settings](../UI_ARCHITECTURE.md#settings)). |
| `/minibar` | route | `app/minibar/page.tsx` | #116 | The whole UI of the `minibar` window. Native opens this path (`minibar.rs`, `WebviewUrl::App("minibar")`); keep it or change it there. |
| Startup gate: "Checking setup…", retry after 8 s or an error | route | `app/layout.tsx` | #110 | Waits for `get_onboarding_status`, then the crash report check. |
| First launch instead of the app | route | `app/layout.tsx`, `components/onboarding/*` | #115 | Old flow has 5 steps (welcome, setup overview, downloads, name, audio test, which also asks for the microphone and macOS audio permissions); the design has 2. `PermissionsStep` is exported but never rendered. Completion reloads the window. The new first launch downloads Parakeet and Whisper Large V3 Turbo in the background (owner decision 2026-11-24). Summaries are a choice on the same step (#123, owner decision 2026-11-25): the built-in model `builtin_ai_get_recommended_model` picks, downloaded only on Install; a cloud provider with the user's key and a model, saved as Settings saves it; or later, which leaves summaries off. The old flow and `initialize_fresh_database` always selected the built-in model; native no longer does. The old setup step's Intel choice (Whisper's Intel GPU version, Intel's libraries for Parakeet on the NPU) joins that download list with #117; Nemotron stays an opt-in in Settings (decision 2026-11-25). |
| Main window `main` | window | native `tauri.conf.json`, `app/layout.tsx` | #110 | Opens at 460×700 and stays resizable (owner decision 2026-11-24); #110 changes `tauri.conf.json` (today 1280×760 with `minWidth` 700; the old layout also raises the minimum to `COMPACT_MIN_WIDTH`). |
| Window controls drawn by the app on Windows | window | `components/WindowControls.tsx`, `hooks/useCustomChrome.ts`, `lib/window-chrome.ts` | #110 | Minimize, maximize (follows `onResized`), close. |
| Close hides the main window to the tray | window | native `lib.rs` | #110 | Native; the UI only needs to expect a hidden window. |
| Minimizing during a recording opens the minibar | window | native `lib.rs` | #116 | Native; the design's minimize hint matches it. |
| Minibar window `minibar` | window | native `minibar.rs` | #116 | 680×72, frameless, on top, no taskbar entry, top centre, draggable, clipped to a 24 px rounded rectangle. The design's smaller pill changes these constants: since #116 as wide as the pill (`resize_minibar`, at most 512) × 52 with a 26 px radius, the closed pill centred ([UI_ARCHITECTURE.md › The minibar](../UI_ARCHITECTURE.md#the-minibar)). |
| Sidebar | window | `components/Sidebar/index.tsx`, `components/Sidebar/SidebarProvider.tsx` | #113 | New recording, import, record for a group, search, Contacts, Groups, the meeting list (by date or group, select, export, delete, F2 rename), Settings, About, resize. The design has no sidebar: the list is Home. Bulk select, export and delete are dropped (owner decision 2026-11-24). |
| Recording pill on other pages | window | `components/recording/RecordingPill.tsx` | #112 | Timer, pause, stop, back to the recording. |
| About dialog from the wordmark | window | `components/About.tsx` | #114 | General › About. |
| Drop an audio file anywhere to import | window | `app/layout.tsx`, `components/ImportAudio/ImportDropOverlay.tsx` | #119 | `tauri://drag-*` events. |
| Context menu off in production | window | `app/layout.tsx` | #110 | |
| Route warmup | window | `components/RouteWarmup.tsx` | dropped | Next.js route prefetching. |
| Chunk-load reload script | window | `app/layout.tsx` | dropped | Next.js chunk errors in WebView2. |
| Browser preview with mock IPC and a sample library | window | `dev/preview/*`, `app/layout.tsx` | #106 | Development only: in a plain browser (no Tauri bridge) `installPreviewMocks` answers commands through Tauri `mockIPC` with sample meetings, models and a live session. Its handlers and fixtures are a starting point for the new mock IPC. |
| Tray menu | tray | native `tray.rs` | #110 | Start, Pause, Resume, Stop Recording; Open Main Window; Settings; Update Available, Restart to Update, Check for Updates; Quit (asks during a recording, native `quit.rs`). Icons: #120, native `tray/icon.rs`: the ring in one colour (a template on macOS), a dot while a recording is open. |
| Tray navigation | tray | `app/layout.tsx` | #110 | `tray-navigate` carries a path; route it client-side (see invariants). |
| Tray Start Recording | tray | native `tray.rs` (`toggle_recording_handler`), `hooks/useRecordingStart.ts` | #110 | The old native code set sessionStorage `autoStartRecording` with `window.eval` and reloaded the window at `/`, where `useRecordingStart` started a recording with no first-launch check; the reload dropped a meeting still being saved and queued post-call jobs. Since #110 it emits `request-recording-toggle` to the main window instead, which the shell hears only once first launch is done ([UI_ARCHITECTURE.md › Tray](../UI_ARCHITECTURE.md#tray)); #112 starts the recording. Native still disables Start until first launch is done or a Parakeet model exists. |
| Ctrl/⌘ K search | hotkey | `components/GlobalSearchDialog.tsx` | #118 | |
| ← / → skip 5 s in the player | hotkey | `components/meeting/AudioPlayerBar.tsx` | #113 | Only while the scrubber has focus. |
| Space plays or pauses the player | hotkey | `components/meeting/AudioPlayerBar.tsx` | #113 | Window-wide while the player is ready and focus is not in a text field. The collision with the design's Space (pause) is settled in [UI_ARCHITECTURE.md › Hotkeys](../UI_ARCHITECTURE.md#hotkeys): on a meeting Space plays and pauses its audio, also during a recording; registered with `useHotkey`. |
| F2 rename, Esc clears the selection in meeting lists | hotkey | `components/Sidebar/index.tsx`, `app/meetings/page.tsx` | #113 | |
| Ctrl/⌘ Enter submits "Regenerate the summary" | hotkey | `components/meeting/MeetingDocument.tsx` | #119 | |

The design adds Ctrl/⌘ R (record), Ctrl/⌘ , (settings), Space (pause) and
Keep on top; they are new in #110, not parity items. Space belongs to the
screen in front: it pauses on the recording screen and plays on a meeting
([UI_ARCHITECTURE.md › Hotkeys](../UI_ARCHITECTURE.md#hotkeys)).

## Tauri commands

217 commands. "Old file" lists up to three callers, leaving out dead code
(`components/onboarding/steps/PermissionsStep.tsx` is never rendered and
`activateOptionalModel` in `lib/optional-model-activation.ts` is never
called). Rows marked "Windows only" or "macOS only" are registered only on
that platform (`#[cfg]` in `generate_handler!`); elsewhere they fail with
"command not found", which the old UI reads as "not available". #106's mock
IPC and the screens that call them (#113, #117) keep that rule: the mock answers
such a command only on its platform
([UI_ARCHITECTURE.md › Mock IPC](../UI_ARCHITECTURE.md#mock-ipc)).

### Recording session and live transcript

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `ask_live_assistant` | command | `components/groups/GroupDetailView.tsx`, `components/recording/LivePanel.tsx` | #112 | "Summarize so far" in the recording window (owner decision 2026-11-24). No UI activity lease: the `recording` busy reason covers it while recording. Native holds nothing of its own today; if an answer can outlive Stop, #112 adds `busy::hold(BusyReason::Summary)` in `live_assistant.rs` (decision 3). The AI chat during recording and on groups stays dropped. |
| `attempt_device_reconnect` | command | `components/RecordingControls.tsx` | #112 | Switch a device while recording; on failure the old device keeps recording. |
| `check_transcription_runtime` | command | `hooks/useRecordingStart.ts` | #112 | First step of a start; a missing runtime blocks the start with its message. |
| `get_recording_meeting_name` | command | `services/recordingService.ts` | #112 | Title of the running recording after a reload. |
| `get_recording_state` | command | `app/layout.tsx`, `services/recordingService.ts` | #112 | Native timer, pause and mute state; the minibar polls it every 500 ms (#116). |
| `get_transcript_history` | command | `services/transcriptService.ts` | #112 | Live transcript backfill after a WebView reload. |
| `get_transcription_status` | command | `services/transcriptService.ts` | #112 | Polled every 500 ms after Stop; the only thing that ends the wait (60 s cap, see invariants). |
| `is_recording` | command | `components/RecordingControls.tsx`, `services/recordingService.ts` | #112 | Probed on mount; a failure shows "Recording is unavailable". |
| `parakeet_has_available_models` | command | `contexts/OnboardingContext.tsx`, `hooks/useRecordingStart.ts`, `lib/parakeet.ts` | #112 | Start prefetch; also onboarding (#115). |
| `parakeet_init` | command | `contexts/OnboardingContext.tsx`, `hooks/useRecordingStart.ts`, `lib/parakeet.ts` | #112 | Start prefetch; also onboarding readiness (#115). |
| `parakeet_is_model_loaded` | command | `hooks/useRecordingStart.ts`, `lib/parakeet.ts` | #112 | Start prefetch. |
| `parakeet_load_model` | command | `hooks/useRecordingStart.ts`, `lib/parakeet.ts` | #112 | Start prefetch; an integrity failure is reported with `modelIntegrityMessage`. |
| `pause_recording` | command | `app/minibar/page.tsx`, `components/GlobalSearchDialog.tsx`, `components/RecordingControls.tsx` +2 | #112 | Also from the minibar (#116), the pill and the search commands (#118). |
| `resume_recording` | command | `app/minibar/page.tsx`, `components/GlobalSearchDialog.tsx`, `components/RecordingControls.tsx` +2 | #112 | Same callers as pause. |
| `set_microphone_muted` | command | `components/RecordingControls.tsx`, `services/recordingService.ts` | #112 | Also the minibar (#116). |
| `set_system_audio_muted` | command | `components/RecordingControls.tsx`, `services/recordingService.ts` | #112 | Also the minibar (#116). |
| `start_audio_level_monitoring` | command | `components/RecordingVoiceLane.tsx`, `components/onboarding/steps/AudioTestStep.tsx` | #109 | Device-preview meters; used by the recording bar (#112) and the mic test (#115). |
| `start_recording_with_devices_and_meeting` | command | `services/recordingService.ts` | #112 | The only start the UI uses: microphone, computer audio device and meeting title. |
| `stop_audio_level_monitoring` | command | `components/RecordingControls.tsx`, `components/RecordingVoiceLane.tsx`, `components/onboarding/steps/AudioTestStep.tsx` | #109 | Pairs with the start; must run on unmount. |
| `stop_recording` | command | `components/RecordingControls.tsx`, `services/recordingService.ts` | #112 | Stop from the recording window; native owns finalization (#32). Requires `args.save_path` (the old UI builds it from `get_database_directory`); native only creates its parent folder. |
| `updater_set_ui_activity` | command | `lib/updater.ts` | #112 | WebView lease for `recordingSave` and `postCall`; see invariants. |
| `whisper_has_available_models` | command | `hooks/useRecordingStart.ts`, `lib/whisper.ts` | #112 | Start prefetch. |
| `whisper_init` | command | `hooks/useRecordingStart.ts`, `lib/whisper.ts` | #112 | Start prefetch when Whisper is the live model. |
| `whisper_is_model_loaded` | command | `hooks/useRecordingStart.ts`, `lib/whisper.ts` | #112 | Start prefetch. |
| `whisper_load_model` | command | `hooks/useRecordingStart.ts`, `lib/whisper.ts` | #112 | Start prefetch. |

### Stop, save and transcript recovery

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `api_save_transcript` | command | `services/storageService.ts` | #112 | Saves the meeting and transcript rows after Stop (with `recordingStartedAt`). |
| `cleanup_checkpoints` | command | `hooks/useTranscriptRecovery.ts` | #112 | Transcript recovery: delete checkpoints after recovery or delete. |
| `discard_recording_folder` | command | `hooks/useRecordingStop.ts` | #112 | Discards a take under 10 s. |
| `get_meeting_folder_path` | command | `contexts/TranscriptContext.tsx`, `hooks/useTranscriptRecovery.ts` | #112 | Folder of the running recording, for save and recovery. |
| `has_audio_checkpoints` | command | `hooks/useTranscriptRecovery.ts` | #112 | Transcript recovery: is there audio to rebuild. |
| `recording_save_finished` | command | `lib/recording-save.ts` | #112 | Answers native Stop with `saved`/`discarded`/`notSaved`/`failed` and the `stop_id`. |
| `recover_audio_from_checkpoints` | command | `hooks/useTranscriptRecovery.ts` | #112 | Transcript recovery: rebuild audio (48 kHz). |

### Minibar

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `enter_compact_mode` | command | `components/RecordingControls.tsx` | #116 | Explicit shrink from the recording window with `elapsedSeconds`; minimizing during a recording opens the bar natively. Since #116 the recording bar's Shrink to floating bar. |
| `exit_compact_mode` | command | `app/minibar/page.tsx` | #116 | Back to the full window. |
| `stop_recording_from_minibar` | command | `app/minibar/page.tsx` | #116 | Native closes the bar and the main window saves (#112). |

### Meetings, notes, folders and action items

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `api_create_action_item` | command | `lib/workspace-api.ts` | dropped | Dropped with the separate action items (owner decision, #218): the summary keeps its action section as text. |
| `api_create_group` | command | `lib/workspace-api.ts` | #113 | New folder; also the search command (#118). |
| `api_delete_action_item` | command | `lib/workspace-api.ts` | dropped | Dropped with the separate action items (owner decision, #218): the summary keeps its action section as text. |
| `api_delete_group` | command | `lib/workspace-api.ts` | #113 | Delete a folder; meetings stay. |
| `api_delete_meeting` | command | `lib/meeting-actions.ts` | #113 | Delete; audio files stay in the recordings folder. |
| `api_get_group` | command | `lib/workspace-api.ts` | #113 | Folder detail (the Groups page used it; the list filter needs only the list). |
| `api_get_meeting` | command | `services/storageService.ts` | #113 | Meeting header data. |
| `api_get_meeting_audio` | command | `lib/workspace-api.ts` | #113 | Player source. |
| `api_get_meeting_group` | command | `lib/workspace-api.ts` | #113 | Folder of a meeting. |
| `api_get_meeting_metadata` | command | `hooks/usePaginatedTranscripts.ts` | #113 | Transcript paging metadata. |
| `api_get_meeting_notes` | command | `lib/workspace-api.ts` | #111 | Notes as Markdown + BlockNote JSON. |
| `api_get_meeting_transcripts` | command | `hooks/meeting-details/useCopyOperations.ts`, `hooks/meeting-details/useSummaryGeneration.ts`, `hooks/usePaginatedTranscripts.ts` +2 | #113 | Paged transcript; also copy, export (#119) and action-item backfill. |
| `api_get_meetings` | command | `components/Sidebar/SidebarProvider.tsx`, `services/storageService.ts` | #113 | Meetings list with summary preview, speaker names and dates. |
| `api_list_action_items` | command | `lib/workspace-api.ts` | dropped | Dropped with the separate action items (owner decision, #218): the summary keeps its action section as text. |
| `api_list_groups` | command | `lib/workspace-api.ts` | #113 | Folders (groups) for the list filter and pickers. |
| `api_list_unsynced_action_meetings` | command | `lib/workspace-api.ts` | #113 | Backfill of older summaries, once per session (`af-action-backfill-done`). |
| `api_save_meeting_notes` | command | `lib/workspace-api.ts` | #111 | Autosaved notes; the live notes are saved here on Stop (#112). |
| `api_save_meeting_title` | command | `lib/meeting-actions.ts` | #113 | Rename. |
| `api_set_meeting_group` | command | `hooks/useRecordingStop.ts`, `lib/workspace-api.ts` | #113 | Move to folder; also files a new recording into its pending group (#112). |
| `api_sync_ai_action_items` | command | `lib/workspace-api.ts` | dropped | Dropped with the separate action items (owner decision, #218): the summary keeps its action section as text. |
| `api_update_action_item` | command | `lib/workspace-api.ts` | dropped | Dropped with the separate action items (owner decision, #218): the summary keeps its action section as text. |
| `api_update_group` | command | `lib/workspace-api.ts` | #113 | Rename/recolor a folder. |
| `get_waveform_peaks` | command | `hooks/useWaveform.ts` | #113 | Waveform in the player (Labs › Waveform scrubbing). |
| `open_meeting_folder` | command | `hooks/meeting-details/useMeetingOperations.ts` | #113 | Open recording folder. |

### Summaries and templates

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `api_cancel_summary` | command | `hooks/meeting-details/useSummaryGeneration.ts` | #113 | Cancel generation. |
| `api_delete_custom_template` | command | `hooks/meeting-details/useTemplates.ts` | #117 | Templates subpage. |
| `api_detect_transcript_summary_language` | command | `lib/summary-language-preferences.ts` | #113 | Detects the transcript language for Auto. |
| `api_get_meeting_detected_summary_language` | command | `lib/summary-language-preferences.ts` | #113 | Cached detected language for Auto. |
| `api_get_meeting_summary_language` | command | `lib/summary-language-preferences.ts` | #119 | Per-meeting summary language (Summary options). |
| `api_get_summary` | command | `app/meeting-details/page.tsx`, `components/Sidebar/SidebarProvider.tsx`, `components/groups/GroupDetailView.tsx` +3 | #113 | Summary status and content; also list preview and export. |
| `api_is_custom_template` | command | `hooks/meeting-details/useTemplates.ts` | #119 | Template editor: built-in or custom; since #117 also the templates list (`src/api/templates.ts`), which offers Delete for custom ones. |
| `api_list_templates` | command | `hooks/meeting-details/useTemplates.ts` | #117 | Templates subpage; also Summary options (#119). |
| `api_process_transcript` | command | `hooks/meeting-details/useSummaryGeneration.ts` | #113 | Generate/regenerate; also the automatic summary after Stop (#112). Without a template native fell back to `daily_standup`; since #117 it uses the stored default (owner decision 2026-11-24), `standard_meeting` while none is stored, and `startSummary` names a template only for a run that picks one. |
| `api_save_custom_template` | command | `hooks/meeting-details/useTemplates.ts` | #119 | Template editor. |
| `api_save_meeting_detected_summary_language` | command | `lib/summary-language-preferences.ts` | #113 | Caches the detected language for Auto; returns `local_fallback` like `api_save_meeting_summary_language`. |
| `api_save_meeting_summary` | command | `components/meeting/MeetingDocument.tsx`, `lib/action-item-sync.ts` | #113 | Edited summary; action-item sync writes it too. |
| `api_save_meeting_summary_language` | command | `lib/summary-language-preferences.ts` | #119 | Returns `local_fallback` when the meeting has no metadata file; the UI then keeps it in localStorage. |
| `builtin_ai_get_model_info` | command | `hooks/meeting-details/useSummaryGeneration.ts`, `lib/builtin-ai.ts` | #113 | Readiness check before generating with the built-in model. |
| `builtin_ai_is_model_ready` | command | `contexts/OnboardingContext.tsx`, `hooks/meeting-details/useSummaryGeneration.ts`, `lib/builtin-ai.ts` | #113 | Same; onboarding uses it too (#115). |

### Speakers, people and voices

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `api_create_person` | command | `lib/workspace-api.ts` | #118 | New contact (search command); also "New contact" in Who said this (#119). |
| `api_delete_person` | command | `lib/workspace-api.ts` | #118 | Delete a contact. |
| `api_get_person_profile` | command | `app/meetings/page.tsx`, `app/person/page.tsx` | #118 | Person screen: details, meetings together; its open action items are dropped (#218). |
| `api_list_people` | command | `lib/workspace-api.ts` | #118 | Contacts for search, the speaker dialog (#119) and filters. |
| `api_merge_people` | command | `lib/workspace-api.ts` | #118 | Merge with another contact. |
| `api_update_person` | command | `lib/workspace-api.ts` | #118 | Edit details. |
| `api_update_person_notes` | command | `lib/workspace-api.ts` | #118 | Private notes, saved as you type, never sent to AI. |
| `delete_voice_profile` | command | `lib/voice-profiles.ts` | #118 | Forget a voice. |
| `diarization_models_available` | command | `components/meeting/MeetingHeader.tsx` | #113 | Shows "change the count" only when a speaker engine is ready. |
| `diarize_meeting` | command | `components/MeetingDetails/PostCallProcessingWorker.tsx`, `components/meeting/MeetingHeader.tsx` | #112 | Post-call speaker pass; "4 speakers · Identify speakers…" reruns it with a count picked and confirmed in a sheet (#113). Changes labels only. |
| `enroll_person_voice` | command | `lib/voice-profiles.ts` | #118 | Update a contact's voice (Labs); also from Who said this (#119). |
| `enroll_voice_profile` | command | `lib/voice-profiles.ts` | #118 | Learn a voice from a meeting (Labs). |
| `list_voice_profiles` | command | `lib/voice-profiles.ts` | #118 | Labs voices on the person screen. |
| `reassign_transcript_speaker` | command | `components/people/SpeakerIdentityDialog.tsx` | #119 | Who said this: one line or all of a voice; optional `from` keeps other voices of an overlap row. |
| `rename_meeting_speaker` | command | `app/meeting-details/page-content.tsx`, `components/people/SpeakerIdentityDialog.tsx` | #119 | Name a voice for the meeting; also the inline rename on the transcript (#113). |

### Import and retranscription

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `api_save_meeting_vocabulary` | command | `components/MeetingDetails/RetranscribeDialog.tsx` | #119 | Enhance transcript: words for this meeting only. |
| `cancel_import_command` | command | `hooks/useImportAudio.ts` | #119 | Cancel import. |
| `cancel_retranscription_command` | command | `components/MeetingDetails/PostCallProcessingWorker.tsx`, `components/MeetingDetails/RetranscribeDialog.tsx` | #112 | Cancel; also #119. |
| `is_retranscription_in_progress_command` | command | `components/MeetingDetails/PostCallProcessingWorker.tsx` | #112 | Re-attach to a running pass after navigation. |
| `select_and_validate_audio_command` | command | `hooks/useImportAudio.ts` | #119 | Pick a file for import. |
| `start_import_audio_command` | command | `hooks/useImportAudio.ts` | #119 | Starts the import; native holds the busy owner. |
| `start_retranscription_command` | command | `components/MeetingDetails/PostCallProcessingWorker.tsx`, `components/MeetingDetails/RetranscribeDialog.tsx` | #112 | Post-call pass after Stop; Enhance transcript (#119) too. Listeners register before the call. |
| `validate_audio_file_command` | command | `hooks/useImportAudio.ts` | #119 | Validate a dropped file. |

### Settings: General and Recording

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `get_audio_devices` | command | `components/RecordingControls.tsx`, `components/onboarding/steps/AudioTestStep.tsx`, `hooks/usePermissionCheck.ts` | #114 | Device lists (moved from the record card); also the bar's "Change inputs" (#112) and the mic test (#115). |
| `get_database_directory` | command | `components/RecordingControls.tsx`, `contexts/ConfigContext.tsx` | #117 | Advanced › Disk, beside Show folder (`open_database_folder`, which the old UI never called); also builds the `stop_recording` save path (#112). Since #117 in `src/api/app.ts`. |
| `get_default_recordings_folder_path` | command | `components/RecordingSettings.tsx`, `contexts/ConfigContext.tsx` | #114 | Shown when no folder is saved. Not called since #114: `get_recording_preferences` already answers the default folder in `save_folder` when none is stored, and `set_recording_preferences` rejects an empty one. |
| `get_recordable_apps` | command | `hooks/useAppAudio.ts` | #117 | Chosen apps subpage. |
| `get_recording_preferences` | command | `components/RecordingControls.tsx`, `components/RecordingSettings.tsx`, `components/TranscriptSettings.tsx` +3 | #114 | Save audio, folder, devices, volumes, chosen apps, Faster live text. |
| `open_external_url` | command | `components/About.tsx`, `components/AboutSettings.tsx`, `components/CudaReconfigurationNotice.tsx` +6 | #106 | Links (About, credits, driver pages); one wrapper in `src/api`: `openExternalUrl` in `src/api/links.ts`. |
| `open_recordings_folder` | command | `components/RecordingSettings.tsx` | #114 | Open folder. |
| `select_custom_app_executable` | command | `hooks/useAppAudio.ts` | #117 | Chosen apps: an app that is not open. |
| `select_recording_folder` | command | `components/RecordingSettings.tsx` | #114 | Change folder. |
| `set_language_preference` | command | `contexts/ConfigContext.tsx` | #114 | Meeting language into native memory; must also run once at startup with the saved value. |
| `set_recording_preferences` | command | `components/RecordingControls.tsx`, `components/RecordingSettings.tsx`, `components/TranscriptSettings.tsx` +1 | #114 | Always read-modify-write the whole object (see invariants). |

### Updates and model catalog

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `model_catalog_check_now` | command | `lib/model-catalog.ts` | #114 | Model updates: check now. |
| `model_catalog_get_status` | command | `lib/model-catalog.ts` | #114 | General › Updates › Model updates. |
| `model_catalog_model_size` | command | `lib/model-catalog.ts` | #117 | Download size of a model not installed. |
| `model_catalog_request_sizes` | command | `lib/model-catalog.ts` | #117 | Asks for sizes of the shown list. |
| `model_update_cancel` | command | `lib/model-catalog.ts` | #117 | Cancel a model update. |
| `model_update_start` | command | `lib/model-catalog.ts` | #117 | Per-model update in Speech models. |
| `updater_check_now` | command | `lib/updater.ts` | #114 | Check. |
| `updater_download_now` | command | `lib/updater.ts` | #114 | Download (only on click). |
| `updater_get_status` | command | `lib/updater.ts` | #114 | General › Updates; also the Home banner (#113). |
| `updater_install_now` | command | `lib/updater.ts` | #114 | Restart and update; also the Home banner (#113). |
| `updater_set_auto_check` | command | `lib/updater.ts` | #114 | Check for updates automatically (`updater.json`). |

### Settings: speech models and Local AI

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `api_get_post_call_transcript_config` | command | `components/MeetingDetails/PostCallProcessingWorker.tsx`, `components/MeetingDetails/RetranscribeDialog.tsx`, `components/TranscriptSettings.tsx` +1 | #117 | After-meeting model; read by the post-call pass (#112) and Enhance (#119). |
| `api_get_transcript_config` | command | `app/settings/page.tsx`, `services/configService.ts` | #117 | Live model (DB settings). |
| `api_get_vocabulary` | command | `components/MeetingDetails/RetranscribeDialog.tsx`, `components/TranscriptSettings.tsx` | #117 | Words to recognize; also Enhance (#119). |
| `api_save_global_vocabulary` | command | `components/TranscriptSettings.tsx` | #117 | Words to recognize (1000 characters). |
| `api_save_post_call_transcript_config` | command | `components/TranscriptSettings.tsx` | #117 | After-meeting model; optional Whisper activation is native (see invariants). |
| `api_save_transcript_config` | command | `components/ParakeetModelManager.tsx`, `components/TranscriptSettings.tsx`, `components/WhisperModelManager.tsx` | #117 | Live model. |
| `force_unload_all_models` | command | `components/LocalStackStatus.tsx` | #117 | Free all memory. |
| `force_unload_stt_models` | command | `components/LocalStackStatus.tsx` | #117 | Unload speech models. |
| `get_local_stack_status` | command | `components/LocalStackStatus.tsx`, `components/onboarding/steps/SetupOverviewStep.tsx`, `hooks/useSpeechChoice.ts` | #117 | Advanced › Local AI; also first launch (#115) and the speech choice. |
| `get_openvino_availability` | command | `hooks/useSpeechChoice.ts` | #117 | Whether the Intel GPU offer applies. |
| `openvino_cancel` | command | `components/settings/ForThisComputer.tsx`, `components/settings/IntelGpuDownload.tsx`, `hooks/useIntelLibraries.ts` | #117 | Windows only. Cancel. |
| `openvino_download` | command | `components/onboarding/steps/SetupOverviewStep.tsx`, `components/settings/ForThisComputer.tsx`, `components/settings/IntelOffer.tsx` | #117 | Windows only. Use your Intel GPU (`choose`); also first launch (#115). |
| `openvino_retry` | command | `components/settings/ForThisComputer.tsx` | #117 | Windows only. Retry. |
| `openvino_runtime_download` | command | `hooks/useIntelLibraries.ts` | #117 | Windows only. Intel libraries download. |
| `openvino_status` | command | `components/settings/ForThisComputer.tsx`, `components/settings/IntelOffer.tsx`, `hooks/useSpeechChoice.ts` | #117 | Windows only. Intel GPU version state. |
| `parakeet_cancel_download` | command | `components/settings/ForThisComputer.tsx`, `lib/parakeet.ts` | #117 | Cancel. |
| `parakeet_delete_corrupted_model` | command | `components/settings/ForThisComputer.tsx`, `lib/parakeet.ts` | #117 | Remove a corrupted copy. |
| `parakeet_download_model` | command | `components/settings/ForThisComputer.tsx`, `contexts/OnboardingContext.tsx`, `lib/parakeet.ts` | #117 | Also the first-launch download (#115). |
| `parakeet_get_available_models` | command | `components/MeetingDetails/PostCallProcessingWorker.tsx`, `components/TranscriptSettings.tsx`, `contexts/OnboardingContext.tsx` +4 | #117 | Speech models list; also start prefetch (#112) and onboarding (#115). |
| `parakeet_npu_retry` | command | `components/settings/ForThisComputer.tsx` | #117 | Windows only. Retry the NPU. |
| `parakeet_npu_status` | command | `hooks/useSpeechChoice.ts` | #117 | Windows only. Intel NPU state for the For this computer card. |
| `parakeet_retry_download` | command | `components/onboarding/steps/DownloadProgressStep.tsx`, `contexts/OnboardingContext.tsx` | #115 | Retry in first launch. |
| `speech_choice_copy_retires` | command | `hooks/useSpeechChoice.ts` | #117 | Windows only. Whether the Compressed copy will be removed after the GPU version's first pass. |
| `speech_choice_remove_gpu_version` | command | `components/settings/ForThisComputer.tsx` | #117 | Windows only. Remove the Intel GPU version. |
| `uninstall_optional_model` | command | `contexts/OptionalModelDownloadsContext.tsx` | #117 | Native removal of Whisper/Nemotron; refuses during a recording and resets choices that used it. |
| `whisper_cancel_download` | command | `components/settings/ForThisComputer.tsx`, `lib/whisper.ts` | #117 | Cancel. |
| `whisper_delete_corrupted_model` | command | `lib/whisper.ts` | #117 | Remove a corrupted copy. |
| `whisper_download_model` | command | `components/settings/ForThisComputer.tsx`, `contexts/OptionalModelDownloadsContext.tsx`, `lib/whisper.ts` | #117 | `enablePostCall=true` makes native activate it as the after-meeting model. First launch also downloads Whisper Large V3 Turbo in the background (#115, owner decision 2026-11-24). |
| `whisper_get_available_models` | command | `components/MeetingDetails/PostCallProcessingWorker.tsx`, `components/TranscriptSettings.tsx`, `contexts/OptionalModelDownloadsContext.tsx` +3 | #117 | Speech models list; also the post-call pass (#112). |
| `whisper_get_models_directory` | command | `contexts/ConfigContext.tsx`, `lib/whisper.ts` | #117 | Advanced › Local AI › folders. |

### Settings: speakers

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `diarization_get_status` | command | `components/DiarizationSettings.tsx`, `components/LabsSettings.tsx`, `contexts/OptionalModelDownloadsContext.tsx` +1 | #117 | AI › Speakers; also Labs and speaker dialogs. |
| `download_diarization_models` | command | `components/DiarizationSettings.tsx`, `contexts/OptionalModelDownloadsContext.tsx` | #117 | Nemotron's Install (#123): choosing the engine no longer downloads it, and installing no longer chooses it; it is a choice once installed. The new `cancel_diarization_download` cancels it; a stream that stalls sees the Cancel only at its next chunk or when the client's one-hour timeout ends it. Progress events carry the `engine`, so a Pyannote repair never reads as Nemotron's download, and a download that did not finish ends with an `error` or `cancelled` event. |
| `open_diarization_model_directory` | command | `components/DiarizationSettings.tsx` | #117 | Model files and credits › Open folder. |
| `set_diarization_config` | command | `components/DiarizationSettings.tsx` | #117 | Speech threshold. |
| `set_diarization_engine` | command | `components/DiarizationSettings.tsx` | #117 | Pyannote or Nemotron. |

### Settings: summary model

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `api_get_api_key` | command | `components/ModelSettingsModal.tsx`, `components/SummaryModelSettings.tsx`, `contexts/ConfigContext.tsx` | #117 | Per provider: claude, groq, openai, openrouter. |
| `api_get_custom_openai_config` | command | `components/ModelSettingsModal.tsx`, `components/SummaryModelSettings.tsx`, `services/configService.ts` | #117 | Custom server. |
| `api_get_model_config` | command | `app/meeting-details/page.tsx`, `components/ModelSettingsModal.tsx`, `components/SummaryModelSettings.tsx` +1 | #117 | Summary model; the simple mode shows it read-only (#114). |
| `api_save_custom_openai_config` | command | `components/ModelSettingsModal.tsx`, `services/configService.ts` | #117 | Endpoint, model, key, max tokens, temperature, top P. |
| `api_save_model_config` | command | `app/meeting-details/page-content.tsx`, `app/meeting-details/page.tsx`, `components/SummaryModelSettings.tsx` | #117 | Provider, model, Ollama endpoint, max summary length. |
| `api_test_custom_openai_connection` | command | `components/ModelSettingsModal.tsx`, `services/configService.ts` | #117 | Test connection. |
| `builtin_ai_cancel_download` | command | `components/BuiltInModelManager.tsx`, `lib/builtin-ai.ts` | #117 | Cancel. |
| `builtin_ai_delete_model` | command | `components/BuiltInModelManager.tsx`, `lib/builtin-ai.ts` | #117 | Delete. |
| `builtin_ai_download_model` | command | `components/BuiltInModelManager.tsx`, `components/onboarding/steps/DownloadProgressStep.tsx`, `contexts/OnboardingContext.tsx` +1 | #117 | Also first launch, in the background (#115, owner decision 2026-11-24). |
| `builtin_ai_get_recommended_model` | command | `contexts/OnboardingContext.tsx` | #115 | First launch downloads the summary model it picks, in the background (owner decision 2026-11-24). |
| `builtin_ai_list_models` | command | `components/BuiltInModelManager.tsx`, `components/ModelSettingsModal.tsx`, `lib/builtin-ai.ts` | #117 | Built-in models with memory-based recommendation. |
| `delete_ollama_model` | command | `components/ModelSettingsModal.tsx` | #117 | Remove an Ollama model. |
| `get_anthropic_models` | command | `components/ModelSettingsModal.tsx` | #117 | Model list. |
| `get_groq_models` | command | `components/ModelSettingsModal.tsx` | #117 | Model list. |
| `get_ollama_models` | command | `app/meeting-details/page.tsx`, `components/ModelSettingsModal.tsx`, `contexts/ConfigContext.tsx` +1 | #117 | Fetch models from the endpoint. |
| `get_openai_models` | command | `components/ModelSettingsModal.tsx` | #117 | Model list. |
| `get_openrouter_models` | command | `components/ModelSettingsModal.tsx` | #117 | Model list. |
| `pull_ollama_model` | command | `components/ModelSettingsModal.tsx` | #117 | Get a model. |

### Settings: Labs and AI agents

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `add_to_claude_desktop` | command | `components/AgentAccessSettings.tsx` | #117 | Connect an agent › Claude Desktop. |
| `get_agent_access` | command | `components/AgentAccessSettings.tsx` | #117 | Advanced › AI agents. |
| `get_parakeet_gpu_enabled` | command | `lib/labs-features.ts` | #117 | Labs › Parakeet on the GPU (Windows; hidden when the NPU runs Parakeet). |
| `get_voice_profiles_enabled` | command | `lib/labs-features.ts` | #117 | Labs › Voice profiles. |
| `get_whisper_strict_silence` | command | `lib/labs-features.ts` | #117 | Labs › Whisper silence guard. |
| `set_agent_access` | command | `components/AgentAccessSettings.tsx` | #117 | Writes `mcp-server.json` next to the database. |
| `set_parakeet_gpu_enabled` | command | `lib/labs-features.ts` | #117 | Labs › Parakeet on the GPU. |
| `set_voice_profiles_enabled` | command | `lib/labs-features.ts` | #117 | Labs › Voice profiles. |
| `set_whisper_strict_silence` | command | `lib/labs-features.ts` | #117 | Labs › Whisper silence guard. |

### First launch, permissions and startup

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `check_default_legacy_database` | command | `contexts/OnboardingContext.tsx` | #115 | Not called: importing it copied the file onto itself, emptying it on Linux and macOS; `initialize_fresh_database` migrates that file itself (`DatabaseManager::new`). |
| `check_first_launch` | command | `contexts/OnboardingContext.tsx` | #115 | Whether native holds the database; Protocol answers it from `AppState` instead of the file, which a failed set-up leaves behind. |
| `check_homebrew_database` | command | `contexts/OnboardingContext.tsx` | #115 | macOS Homebrew-era database to import. |
| `complete_onboarding` | command | `contexts/OnboardingContext.tsx` | #115 | Ends first launch. Since #123 it takes the chosen `provider` and an optional built-in `model`, writes the summary model only for built-in AI, and records `selected_summary_provider`. |
| `create_crash_report_zip` | command | `services/crashReportService.ts` | #110 | Crash report sheet (owner decision 2026-11-24); saves a zip through the dialog plugin. |
| `dismiss_pending_crash_report` | command | `services/crashReportService.ts` | #110 | Crash report sheet: dismiss (owner decision 2026-11-24). |
| `get_cuda_reconfiguration_status` | command | `components/CudaReconfigurationNotice.tsx`, `components/onboarding/steps/SetupOverviewStep.tsx` | dropped | Release builds have no `cuda` feature, so it always answers not applicable; the CUDA notice is dropped (owner decision 2026-11-24). |
| `get_onboarding_status` | command | `app/layout.tsx`, `contexts/OnboardingContext.tsx` | #115 | The shell (#110) gates the app on it at startup with a retry screen. |
| `get_pending_crash_report` | command | `services/crashReportService.ts` | #110 | Crash report sheet at startup (owner decision 2026-11-24). |
| `get_system_audio_permission_status` | command | `hooks/usePermissionCheck.ts` | #113 | Home banner "macOS did not allow audio". |
| `import_and_initialize_database` | command | `contexts/OnboardingContext.tsx` | #115 | Imports a legacy database. |
| `initialize_fresh_database` | command | `contexts/OnboardingContext.tsx` | #115 | Creates the database on a first launch (see invariants). |
| `open_system_settings` | command | `components/PermissionWarning.tsx` | #113 | macOS only. Home permission banner: opens the privacy pane. |
| `save_onboarding_status_cmd` | command | `contexts/OnboardingContext.tsx` | #115 | Step progress (`onboarding-status.json`). |
| `trigger_microphone_permission` | command | `components/onboarding/steps/AudioTestStep.tsx`, `hooks/usePermissionCheck.ts` | #115 | Microphone permission from the first-launch audio test; also the Home banner (#113). |
| `trigger_system_audio_permission_command` | command | `components/onboarding/steps/AudioTestStep.tsx`, `hooks/usePermissionCheck.ts` | #115 | macOS Audio Capture permission from the first-launch audio test; also the Home banner (#113). |

### Search

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `api_global_search` | command | `components/GlobalSearchDialog.tsx` | #118 | People, folders, meetings, said in a meeting, in a summary (action item hits dropped in #218: they are summary text). |

### Dropped commands

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `api_ask_meeting` | command | `lib/workspace-api.ts` | dropped | AI chat (`ChatThread`) dropped by the owner. |
| `api_set_meetings_group` | command | `lib/workspace-api.ts` | dropped | Bulk move; bulk actions are dropped (owner decision 2026-11-24). |
| `ask_person` | command | `app/person/page.tsx` | dropped | AI chat on the person page dropped. |
| `builtin_ai_get_available_summary_model` | command | `lib/builtin-ai.ts` | dropped | `BuiltInAIAPI` is never used. |
| `get_meeting_detection_settings` | command | `components/MeetingDetectionSettings.tsx`, `lib/labs-features.ts` | dropped | Meeting detection and auto-record are dropped by the owner (#102 turned detection off). |
| `get_notification_settings` | command | `contexts/ConfigContext.tsx` | dropped | General › Notifications; desktop notifications are dropped (owner decision 2026-11-24, native removal #126). |
| `open_models_folder` | command | `lib/whisper.ts` | dropped | Only through an unused `WhisperAPI` wrapper; Local AI › Show folder (#117) may use it. |
| `open_parakeet_models_folder` | command | `lib/parakeet.ts` | dropped | Only through an unused `ParakeetAPI` wrapper. |
| `parakeet_get_current_model` | command | `lib/parakeet.ts` | dropped | Only through an unused `ParakeetAPI` wrapper. |
| `parakeet_get_models_directory` | command | `lib/parakeet.ts` | dropped | Only through an unused `ParakeetAPI` wrapper. |
| `parakeet_transcribe_audio` | command | `lib/parakeet.ts` | dropped | Only through the unused `ParakeetAPI.transcribeAudio` wrapper. |
| `parakeet_validate_model_ready` | command | `lib/parakeet.ts` | dropped | Only through an unused `ParakeetAPI` wrapper. |
| `set_meeting_detection_settings` | command | `components/MeetingDetectionSettings.tsx`, `lib/labs-features.ts` | dropped | Meeting detection and auto-record are dropped by the owner. |
| `set_notification_settings` | command | `contexts/ConfigContext.tsx` | dropped | Wrote `show_recording_started` and `show_recording_stopped` together; dropped with desktop notifications (owner decision 2026-11-24, native removal #126). |
| `show_simple_notification` | command | `app/layout.tsx` | dropped | OS notification for `recording-audio-route-warning`; desktop notifications are dropped (owner decision 2026-11-24, native removal #126). The warning stays an in-app toast (#112). |
| `start_recording` | command | `services/recordingService.ts` | dropped | Only `recordingService.startRecording` calls it, and nothing calls that. |
| `whisper_get_current_model` | command | `lib/whisper.ts` | dropped | Only through an unused `WhisperAPI` wrapper. |
| `whisper_transcribe_audio` | command | `lib/whisper.ts` | dropped | Only reachable through the unused `WhisperAPI.transcribeAudio` wrapper. |
| `whisper_validate_model_ready` | command | `lib/whisper.ts` | dropped | Only through an unused `WhisperAPI` wrapper. |

## Tauri events

### Native events the old UI listens to

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `recording-started` | event | `services/recordingService.ts` | #112 | The RECORDING state comes from native, not from the start call. |
| `recording-stopped` | event | `services/recordingService.ts` | #112 | |
| `recording-paused` | event | `services/recordingService.ts` | #112 | The minibar polls `is_paused` instead (#116). |
| `recording-resumed` | event | `services/recordingService.ts` | #112 | |
| `recording-stop-complete` | event | `contexts/RecordingPostProcessingProvider.tsx` | #112 | Main window only, with `stop_id`, folder and meeting name; starts the save. |
| `recording-error` | event | `contexts/RecordingPostProcessingProvider.tsx` | #112 | |
| `microphone-mute-changed` | event | `services/recordingService.ts` | #112 | The minibar polls the mutes instead (#116). |
| `system-audio-mute-changed` | event | `services/recordingService.ts` | #112 | The minibar polls the mutes instead (#116). |
| `recording-audio-levels` | event | `components/LiveAudioVisualizer.tsx` | #109 | Live meters during a recording (bar, minibar). |
| `audio-levels` | event | `components/RecordingVoiceLane.tsx`, `components/onboarding/steps/AudioTestStep.tsx` | #109 | Device-preview meters. |
| `recording-audio-route-warning` | event | `app/layout.tsx` | #112 | In-app toast for 30 s. Its OS notification is dropped with desktop notifications (owner decision 2026-11-24, native removal #126). |
| `live-diarization-error` | event | `app/layout.tsx` | #112 | "Live speaker labeling unavailable"; no engine substitution. |
| `chunk-drop-warning` | event | `hooks/useModalState.ts`, `services/recordingService.ts` | dropped | Native never emits it, so "Transcription is falling behind" never opens. #112 adds a native emitter if it wants that warning. |
| `transcript-update` | event | `services/transcriptService.ts` | #112 | Live lines; ordered and buffered by sequence id, saved to IndexedDB. |
| `transcript-error` | event | `services/transcriptService.ts`, `components/RecordingControls.tsx` | dropped | Native never emits it. |
| `transcription-error` | event | `services/transcriptService.ts`, `components/RecordingControls.tsx`, `hooks/useModalState.ts` | #112 | "The recording stopped" dialog. |
| `transcription-warning` | event | `hooks/useModalState.ts` | #112 | |
| `transcription-complete` | event | `services/transcriptService.ts`, `hooks/useRecordingStop.ts` | dropped | Native never emits it; the wait after Stop ends by polling `get_transcription_status`. |
| `speech-detected` | event | `services/recordingService.ts` | dropped | `onSpeechDetected` exists but nothing subscribes. |
| `request-recording-toggle` | event | `app/layout.tsx` | #110 | Nothing emitted it in the old app. Since #110 the tray's Start Recording emits it to the main window instead of reloading `/` (see Routes and windows). |
| `tray-navigate` | event | `app/layout.tsx` | #110 | Path to open. |
| `meeting-detected` | event | `app/layout.tsx` | dropped | Meeting detection dropped. |
| `meeting-ended` | event | `app/layout.tsx` | dropped | Auto-record dropped. |
| `start-recording-from-notification` | event | `app/layout.tsx` | dropped | Desktop notifications are dropped with the Windows toast and its "Start recording" button (owner decision 2026-11-24); native removal is #126. Every Windows toast emitted it from that button and from a click on its body (`notifications/native_windows.rs`). |
| `retranscription-progress` | event | `components/MeetingDetails/PostCallProcessingWorker.tsx`, `components/MeetingDetails/RetranscribeDialog.tsx` | #112 | Also Enhance transcript (#119); filter by meeting id. |
| `retranscription-complete` | event | same, `hooks/useSpeechChoice.ts` | #112 | The speech choice refreshes on it: the Intel GPU version ran or fell back (#117). |
| `retranscription-error` | event | same, `hooks/useSpeechChoice.ts` | #112 | Same refresh as on completion (#117). |
| `import-progress` | event | `hooks/useImportAudio.ts` | #119 | |
| `import-complete` | event | `hooks/useImportAudio.ts`, `hooks/useSpeechChoice.ts` | #119 | Also refreshes the speech choice (#117). |
| `import-error` | event | `hooks/useImportAudio.ts`, `hooks/useSpeechChoice.ts` | #119 | Also refreshes the speech choice (#117). |
| `summary-progress` | event | `hooks/meeting-details/useSummaryGeneration.ts` | #113 | |
| `transcript-config-changed` | event | `contexts/ConfigContext.tsx` | #117 | Live model changed natively. |
| `post-call-transcript-config-changed` | event | `contexts/OptionalModelDownloadsContext.tsx`, `hooks/useSpeechChoice.ts` | #117 | After-meeting model changed natively (optional Whisper activation). |
| `diarization-engine-changed` | event | `components/DiarizationSettings.tsx`, `hooks/useDiarizationEngine.ts`, `contexts/OptionalModelDownloadsContext.tsx` | #117 | Native Nemotron activation; refreshes Settings, first launch and open speaker dialogs. |
| `diarization-download-progress` | event | `components/DiarizationSettings.tsx`, `contexts/OptionalModelDownloadsContext.tsx` | #117 | |
| `optional-model-removed` | event | `components/WhisperModelManager.tsx`, `contexts/OptionalModelDownloadsContext.tsx`, `hooks/useSpeechChoice.ts` | #117 | |
| `model-download-progress` | event | `components/WhisperModelManager.tsx`, `contexts/OptionalModelDownloadsContext.tsx` | #117 | Whisper; stays below 100 % until verified. |
| `model-download-activating` | event | `contexts/OptionalModelDownloadsContext.tsx` | #117 | Whisper verified, being activated. |
| `model-download-complete` | event | `components/WhisperModelManager.tsx`, `contexts/OptionalModelDownloadsContext.tsx`, `hooks/useSpeechChoice.ts` +2 | #117 | |
| `model-download-error` | event | `components/WhisperModelManager.tsx`, `contexts/OptionalModelDownloadsContext.tsx`, `hooks/useSpeechChoice.ts` | #117 | |
| `parakeet-model-download-progress` | event | `components/ParakeetModelManager.tsx`, `components/shared/DownloadProgressToast.tsx`, `hooks/useSpeechChoice.ts` +2 | #117 | Also first launch (#115). |
| `parakeet-model-download-complete` | event | same | #117 | Also first launch (#115). |
| `parakeet-model-download-error` | event | same | #117 | Also first launch (#115). |
| `builtin-ai-download-progress` | event | `components/BuiltInModelManager.tsx`, `components/shared/DownloadProgressToast.tsx`, `contexts/OnboardingContext.tsx` +1 | #117 | Summary model download. |
| `ollama-model-download-progress` | event | `contexts/OllamaDownloadContext.tsx` | #117 | |
| `ollama-model-download-complete` | event | `contexts/OllamaDownloadContext.tsx` | #117 | |
| `ollama-model-download-error` | event | `contexts/OllamaDownloadContext.tsx` | #117 | |
| `openvino-runtime-progress` | event | `hooks/useIntelLibraries.ts` | #117 | Intel libraries download. |
| `openvino-companion-changed` | event | `hooks/useSpeechChoice.ts` | #117 | Intel GPU version state. |
| `parakeet-npu-status` | event | `hooks/useSpeechChoice.ts`, `hooks/useIntelLibraries.ts` | #117 | |
| `model-catalog-changed` | event | `lib/model-catalog.ts`, `hooks/useSpeechChoice.ts` | #117 | Also General › Model updates (#114). |
| `updater-status` | event | `lib/updater.ts` | #114 | Snapshot for Settings, the Home banner (#113) and update toasts. |
| `tauri://drag-enter` | event | `app/layout.tsx` | #119 | Drop overlay. |
| `tauri://drag-leave` | event | `app/layout.tsx` | #119 | |
| `tauri://drag-drop` | event | `app/layout.tsx` | #119 | First audio file opens Import; other files get a toast. |

### Window events inside the WebView

These are DOM events between components of one window, or between windows
through `storage`, plus `model-config-updated`, a Tauri event that only the UI
emits. They are transports, not contracts; the new UI may replace them.
Listed so their effects are not lost.

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `storage` (theme, user name, recent languages) | DOM event | `lib/app-theme.ts`, `hooks/useUserName.ts`, `hooks/useRecentLanguages.ts` | #106 | The minibar follows theme changes made in the main window this way. |
| `optional-model-preferences-changed` | DOM event | `lib/optional-model-activation.ts`, `components/DiarizationSettings.tsx`, `components/TranscriptSettings.tsx` | #117 | Refreshes preference views after a frontend-triggered change. |
| `meetily-labs-changed` | DOM event | `lib/labs.ts`, `hooks/useLabs.ts` | #117 | |
| `meetily-voice-profiles-changed` | DOM event | `lib/voice-profiles.ts`, `hooks/useVoiceProfiles.ts` | #118 | |
| `meetily-app-audio-changed` | DOM event | `hooks/useAppAudio.ts` | #117 | Chosen apps changed. |
| `af-user-name` | DOM event | `hooks/useUserName.ts` | #114 | |
| `af-theme-change` | DOM event | `lib/app-theme.ts` | #106 | |
| `start-recording-from-sidebar` | DOM event | `lib/recording-launch.ts`, `hooks/useRecordingStart.ts` | #112 | Start requests from anywhere. |
| `af-stop-recording` | DOM event | `lib/recording-launch.ts`, `components/RecordingControls.tsx` | #112 | Stop requests from anywhere. |
| `af-pending-group` | DOM event | `lib/groups.ts`, `hooks/usePendingGroup.ts` | #112 | A picker on the folder in the recording header (owner decision 2026-11-24). |
| `af-live-session` | DOM event | `lib/live-session.ts` | #112 | Live title changed; writing notes does not fire it. |
| `af-workspace-change` | DOM event | `lib/workspace-api.ts` | #113 | Cross-view refresh after meeting, folder, person or action-item edits. |
| `open-global-search` | DOM event | `components/Sidebar/index.tsx`, `components/GlobalSearchDialog.tsx` | #118 | |
| `af-open-group-editor` | DOM event | `components/groups/GroupEditor.tsx` | #113 | New folder from anywhere. |
| `confidenceIndicatorChanged` | DOM event | `contexts/ConfigContext.tsx` | dropped | Dispatched by the dead Show confidence setting; nothing listens. |
| `model-config-updated` | UI event | `contexts/ConfigContext.tsx`, `components/SummaryModelSettings.tsx`, `app/meeting-details/page.tsx`, `app/meeting-details/page-content.tsx` | #117 | A Tauri event the UI emits to every window after saving the summary model, so other views reload; native never emits it. Dropped in #117: the main window that saves also reads the model and invalidates its own query; the minibar does not read it. |
| `af-sidebar-width` | DOM event | `components/Sidebar/SidebarProvider.tsx` | dropped | No sidebar in the design. |
| `meetily-automation-changed` | DOM event | `lib/meeting-automation.ts` | dropped | Auto-record dropped. |

## Settings

Where an old setting lived and where the design puts it. "Simple" is the
default settings mode; the rest sits behind the Advanced switch.

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| Theme: light, dark, match system | setting | `components/settings/ThemePicker.tsx`, `lib/app-theme.ts` | #114 | Simple and General. localStorage `meetily_theme`. Also a search command (#118). |
| Your name | setting | `components/PreferenceSettings.tsx`, `hooks/useUserName.ts` | #114 | Simple and General; first launch asks it (#115). localStorage `meetily_user_name`. Shown as "You (name)". |
| Recording started and stopped notifications | setting | `components/PreferenceSettings.tsx` | dropped | Desktop notifications are dropped (owner decision 2026-11-24, native removal #126). One switch wrote `show_recording_started` and `show_recording_stopped` in `notifications.json`. |
| Updates: check now, download, restart and update, release notes | setting | `components/updater/UpdateSettings.tsx` | #114 | General › Updates; old Settings › About. |
| Check for updates automatically | setting | `components/updater/UpdateSettings.tsx` | #114 | `updater.json`. |
| Model updates (catalog check, per-model update) | setting | `components/updater/ModelCatalogSettings.tsx`, `components/ModelUpdateControl.tsx` | #114 | General › Model updates; the per-model notice in Speech models is #117. |
| About: version, GitHub, privacy policy, credits | setting | `components/AboutSettings.tsx`, `components/About.tsx` | #114 | |
| Save audio | setting | `components/RecordingSettings.tsx` | #114 | `auto_save` in `recording_preferences.json`; the design warns when off. |
| Recordings folder: show, change, open | setting | `components/RecordingSettings.tsx` | #114 | `save_folder`; falls back to the default folder. |
| Microphone device | setting | `components/DeviceSelection.tsx`, `components/RecordingControls.tsx` | #114 | Was on the record card; the design moves it to Settings › Recording and keeps "Change inputs" in the recording bar (#112). `preferred_mic_device`. |
| Computer audio device | setting | same | #114 | `preferred_system_device`. |
| Mic volume | setting | `components/RecordingVoiceLane.tsx`, `components/RecordingControls.tsx` | #114 | `mic_gain` 0.5–3.0. |
| System volume | setting | same | #114 | `system_gain`. |
| Computer audio: all apps or only chosen apps | setting | `components/recording/AppAudioSource.tsx`, `hooks/useAppAudio.ts` | #114 | `per_app_recording_enabled`; Windows and macOS. The app list is a subpage (#117). |
| Chosen apps list | setting | `components/recording/AppAudioSource.tsx` | #117 | `per_app_targets`; open apps, apps playing sound, browse for an executable. |
| Import a recording | setting | `app/settings/page.tsx` (`ImportCard`) | #114 | Opens Import (#119). Settings › Recording shows the row with its button disabled until #119 wires it. |
| Recording file format | setting | native `recording_preferences.rs` | #114 | `file_format`; never shown. Keep it when saving (see invariants). |
| System audio backend | setting | native `recording_preferences.rs` | #114 | `system_audio_backend`; never shown, keep when saving. |
| Legacy single app target | setting | native `recording_preferences.rs`, `hooks/useAppAudio.ts` | #117 | `per_app_target_app` and `per_app_target_name` follow `per_app_targets[0]` and are null when the list is empty: native re-adds a target from them when the list is empty, so a stale value brings a removed app back. |
| Recording notification store key | setting | `components/RecordingSettings.tsx` | dropped | `show_recording_notification` in `preferences.json`: loaded and saved, but no switch renders it and nothing else reads it. |
| Model during the meeting | setting | `components/TranscriptSettings.tsx` | #117 | AI. DB settings via `api_save_transcript_config`. |
| Model after the meeting | setting | `components/TranscriptSettings.tsx` | #117 | AI. `api_save_post_call_transcript_config`; "Same as during the meeting" option. |
| Meeting language | setting | `components/TranscriptSettings.tsx`, `contexts/ConfigContext.tsx`, `app/_components/SettingsModal.tsx` | #114 | Simple and AI (#117). localStorage `primaryLanguage`; locked while recording. |
| Faster live text | setting | `components/TranscriptSettings.tsx` | #117 | `real_time_transcription` in `recording_preferences.json`. |
| Show confidence | setting | `app/_components/SettingsModal.tsx` | dropped | Dead: `VirtualizedTranscriptView` declares `showConfidence` but never reads it, and nothing listens for `confidenceIndicatorChanged`. The design shows it in AI; a working version is new work, not parity. |
| Words to recognize | setting | `components/TranscriptSettings.tsx` | #117 | Global vocabulary, 1000 characters. |
| Speech models: For this computer, All models | setting | `components/settings/ForThisComputer.tsx`, `components/ParakeetModelManager.tsx`, `components/WhisperModelManager.tsx` | #117 | Speech models subpage: download, cancel, remove, retry, update. |
| Intel GPU / NPU offer, "Not now" | setting | `components/settings/IntelOffer.tsx`, `lib/speech-choice.ts` | #117 | Dismissal per device in localStorage `meetily-intel-offer-dismissed`. |
| Speaker engine: Pyannote or Nemotron | setting | `components/DiarizationSettings.tsx` | #117 | `diarization_config.json`. Nemotron download and removal live here. |
| Speech threshold (Nemotron) | setting | `components/DiarizationSettings.tsx` | #117 | `set_diarization_config`. |
| Speaker model files and credits, open folder | setting | `components/DiarizationSettings.tsx` | #117 | |
| Summarize automatically | setting | `components/SummaryModelSettings.tsx` | #114 | Simple and AI. localStorage `isAutoSummary`, default on. |
| Summary language | setting | `components/SummaryLanguageSettings.tsx`, `lib/summary-language-preferences.ts` | #114 | Simple and AI. Default in localStorage `summaryLanguageDefault`, recents in `summaryLanguageRecents`. Codes come from `lib/summary-languages.ts`, which must match native `language_name_from_code`: saving an unknown code for a meeting fails, and a summary asked for in one comes out in English without an error. |
| Summary model: provider and model | setting | `components/SummaryModelSettings.tsx`, `components/ModelSettingsModal.tsx` | #117 | Summary model subpage; simple mode shows it (#114). Providers: built-in, Claude, OpenAI, Groq, OpenRouter, Ollama, custom server. DB settings. |
| API keys per provider | setting | `components/ModelSettingsModal.tsx` | #117 | DB settings. |
| Ollama endpoint, get or remove a model | setting | `components/ModelSettingsModal.tsx`, `contexts/OllamaDownloadContext.tsx` | #117 | |
| Custom server: endpoint, model, key, max tokens, temperature, top P, test | setting | `components/ModelSettingsModal.tsx` | #117 | |
| Maximum summary length | setting | `components/ModelSettingsModal.tsx` | #117 | `summaryMaxTokens`. |
| Built-in summary models: download, cancel, delete | setting | `components/BuiltInModelManager.tsx` | #117 | Recommendation by memory. |
| Summary templates | setting | `hooks/meeting-details/useTemplates.ts`, `components/MeetingDetails/TemplateEditorModal.tsx` | #117 | Templates subpage; the editor is #119. #117 adds a stored default template and the native part so the automatic summary uses it instead of the `daily_standup` fallback (owner decision 2026-11-24). |
| Let AI agents read your meetings | setting | `components/AgentAccessSettings.tsx` | #117 | Advanced › AI agents; `mcp-server.json`. |
| Connect Claude Code, Claude Desktop, set up by hand | setting | `components/AgentAccessSettings.tsx` | #117 | Connect an agent subpage. |
| Local AI: loaded models, unload, free memory, disk | setting | `components/LocalStackStatus.tsx` | #117 | Advanced › Local AI. |
| Local AI › Network ("No telemetry…") | setting | `components/LocalStackStatus.tsx` | dropped | Owner decision 2026-11-25: a statement with no control; the privacy policy says it. |
| Labs › Waveform scrubbing | setting | `components/LabsSettings.tsx`, `lib/labs.ts` | #117 | localStorage only (`meetily-labs-v1`); used by the player (#113). |
| Labs › Clean transcript | setting | same | #117 | localStorage only; used by the transcript view and summaries (#113). |
| Labs › Whisper silence guard | setting | `lib/labs-features.ts` | #117 | Native `whisper_strict_silence.txt`, mirrored in `meetily-labs-v1`. |
| Labs › Voice profiles, learned voices | setting | `lib/labs-features.ts`, `components/LabsSettings.tsx` | #117 | Native `voice_profiles_enabled.txt`; the voices list goes to the person screen (#118). |
| Labs › Parakeet on the GPU | setting | `lib/labs-features.ts` | #117 | Native `parakeet_gpu_enabled.txt`; Windows; hidden when the NPU runs Parakeet. |
| Labs › Meeting automation | setting | `components/LabsSettings.tsx`, `lib/meeting-automation.ts` | dropped | Auto-record dropped. |
| Meeting detection: offer to record, start and stop automatically | setting | `components/MeetingDetectionSettings.tsx` | dropped | Already hidden since #102; dropped by the owner. |
| Summary template for one meeting | setting | `components/meeting/MeetingDocument.tsx` | #119 | Summary options. Not saved today. |
| Summary language for one meeting | setting | `lib/summary-language-preferences.ts`, `components/LanguagePickerPopover.tsx` | #119 | Summary options; `metadata.json` or the localStorage fallback. Same codes as Summary language. |
| Words for one meeting | setting | `components/MeetingDetails/RetranscribeDialog.tsx` | #119 | Enhance transcript. |
| Export link style: generic or Obsidian | setting | `components/MeetingDetails/MeetingExportDialog.tsx` | #119 | localStorage `meetily_export_link_style`. |
| Folder for the next recording | setting | `components/RecordingControls.tsx`, `lib/groups.ts` | #112 | A picker on the folder in the recording header (owner decision 2026-11-24). |
| Meeting list arranged by date or group | setting | `components/Sidebar/index.tsx` | dropped | localStorage `af-sidebar-group-by`; the design filters by folder. |
| Notes and transcript split width | setting | `app/meeting-details/page-content.tsx` | dropped | localStorage `af-meeting-notes-width`; the design uses tabs. |
| Live side panel open | setting | `components/recording/LiveSession.tsx` | dropped | localStorage `af-live-panel-open`; the design uses tabs. |

Not shown in the old UI and not in the design: Nemotron's maximum speakers
and model unload timeouts. They stay native defaults and must survive saves
(see invariants). The other notification fields (paused, resumed, reminders,
sound, Do Not Disturb) go with desktop notifications (owner decision 2026-11-24, native
removal #126).

## Dialogs, notices and banners

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| Before you record (disclosure and consent) | dialog | `components/RecordingNotice.tsx` | dropped | Dropped by the owner decision 2026-11-24: the new UI has no recording disclosure notice. |
| Protocol encountered a problem (crash report) | dialog | `components/CrashReportDialog.tsx`, `services/crashReportService.ts` | #110 | Kept, as a sheet at startup (owner decision 2026-11-24). |
| Interrupted meetings: preview, recover, delete (with confirm) | dialog | `components/TranscriptRecovery/TranscriptRecovery.tsx`, `hooks/useTranscriptRecovery.ts` | #112 | Once per session; "Meeting recovered" toast opens the meeting. |
| Transcription language (Whisper only) | dialog | `app/_components/SettingsModal.tsx` | dropped | Language moves to Settings (#114) and cannot change during a recording. |
| Set up transcription to record / Transcription models | dialog | `app/_components/SettingsModal.tsx`, `hooks/useModalState.ts` | #112 | Shown when Record has no model; the design sends the user to Speech models (#117) instead of a modal. |
| The recording stopped | dialog | `app/_components/SettingsModal.tsx` | #112 | `transcription-error`. |
| Transcription is falling behind | dialog | `app/_components/SettingsModal.tsx` | dropped | Opens only on `chunk-drop-warning`, which native never emits. |
| Finishing your recording / Saving your meeting / Opening your meeting | notice | `components/PostCallHandoffCard.tsx` | #112 | The design: minibar "Finishing…", then the processing screen. |
| Post-call processing: speaker count, progress, cancel, continue without audio | dialog | `components/MeetingDetails/PostCallProcessingDialog.tsx`, `PostCallProcessingWorker.tsx` | #112 | The design drops the count question for a status line and "N speakers · change" (#113). |
| Identify speakers again (count or automatic) | dialog | `components/meeting/MeetingHeader.tsx` | #113 | The Identify speakers sheet (`features/dialogs/identify`), from "Identify speakers…" next to the count on the Transcript tab and the menu's Identify speakers again: Detect automatically or a count, then Identify. Picking a count alone starts nothing. |
| Delete this meeting? | dialog | `components/meeting/MeetingHeader.tsx`, `components/Sidebar/index.tsx`, `app/meetings/page.tsx` | #113 | Audio stays in the recordings folder. |
| Regenerate the summary (instructions, template, language) | dialog | `components/meeting/MeetingDocument.tsx` | #119 | Summary options › Write again. |
| Summary model settings from a meeting ("Choose a summary provider") | dialog | `components/meeting/MeetingDocument.tsx`, `components/ModelSettingsModal.tsx` | #119 | Summary options › Model › Change; the page itself is #117. |
| Enhance transcript | dialog | `components/MeetingDetails/RetranscribeDialog.tsx` | #119 | Language, model, words for this meeting or all. |
| Import a recording, drop overlay | dialog | `components/ImportAudio/ImportAudioDialog.tsx`, `ImportDropOverlay.tsx` | #119 | Title, language, model; the design adds a folder. |
| Export this meeting | dialog | `components/MeetingDetails/MeetingExportDialog.tsx`, `lib/meeting-export.ts`, `lib/exportSummary.ts` | #119 | Content, format (PDF, Word, text, Markdown, JSON, clipboard), link style. |
| Export several meetings | dialog | `components/meetings/ExportMeetingsDialog.tsx` | dropped | Bulk actions are dropped (owner decision 2026-11-24). |
| Template editor | dialog | `components/MeetingDetails/TemplateEditorModal.tsx` | #119 | |
| Who said this line / Who is Speaker N | dialog | `components/people/SpeakerIdentityDialog.tsx` | #119 | Yourself, a contact, a new contact, or merge with another voice in the meeting; one line or every line; works during a recording too. |
| Language picker | dialog | `components/LanguagePickerPopover.tsx`, `components/LanguageSelection.tsx` | #119 | Inside Summary options and Import. The summary picker uses the codes of `lib/summary-languages.ts` (see Settings › Summary language). |
| New contact / Edit contact | dialog | `components/people/ContactDialog.tsx` | #118 | Person › Edit; search › New contact. |
| Merge contacts | dialog | `components/people/MergeContactsDialog.tsx` | #118 | |
| Person card popover from a name | dialog | `components/people/PersonCard.tsx` | #118 | A name opens the person screen. |
| Delete contact | dialog | `app/person/page.tsx` | #118 | Bulk delete on Contacts is dropped with that page. |
| New group / edit group | dialog | `components/groups/GroupEditor.tsx` | #113 | New folder; group schedules are dropped. |
| Add meetings to a group | dialog | `components/groups/AddMeetingsDialog.tsx` | #113 | Move to folder. |
| Delete group | dialog | `components/groups/GroupDetailView.tsx` | #113 | Delete folder. |
| Remove model? (Parakeet, Whisper, Intel GPU version) | dialog | `components/settings/ModelRow.tsx`, `components/settings/ForThisComputer.tsx` | #117 | |
| Remove NVIDIA Nemotron? | dialog | `components/DiarizationSettings.tsx` | #117 | |
| Search and commands | dialog | `components/GlobalSearchDialog.tsx` | #118 | Groups: People, Groups, Meetings, Said in a meeting, In a summary (Action items dropped, #218); commands: record, pause, stop, import, new contact, new group, go to, theme. |
| Update pill and panel | banner | `components/updater/UpdateIndicator.tsx`, `UpdatePanel.tsx`, `ReleaseNotes.tsx` | #113 | Home banner "Update ready". |
| Update available / ready / failed | toast | `components/updater/UpdateToasts.tsx` | #113 | Seen keys in localStorage `protocol-updater-seen-v1`. |
| Download progress panel | toast | `components/shared/DownloadProgressToast.tsx` | #117 | Replaced by one status line in the bottom bar while any download runs (Parakeet, built-in summary model, Whisper, Nemotron); a click opens Settings › Speech models (owner decision 2026-11-24). The line sits in #110's bar. |
| Protocol can't hear your microphone / computer audio | banner | `components/PermissionWarning.tsx`, `hooks/usePermissionCheck.ts` | #113 | Home banner with a button to the privacy pane; the design adds "Check again". |
| System audio level advice | notice | `lib/system-audio-level.ts`, `components/LiveAudioVisualizer.tsx` | #112 | Live meter warning; see `docs/SYSTEM_AUDIO_LEVEL_ADVICE.md`. |
| Recording start errors (integrity, still downloading, no model) | toast | `lib/recording-start-errors.ts`, `hooks/useRecordingStart.ts` | #112 | |
| Live speaker labeling unavailable | toast | `app/layout.tsx` | #112 | |
| Recording audio route warning | toast | `app/layout.tsx` | #112 | Stays in the app; its OS notification is dropped (owner decision 2026-11-24, native removal #126). |
| Please complete setup first | toast | `app/layout.tsx` | dropped | Unreachable: the `request-recording-toggle` listener has no emitter, and the notification and detection listeners are not registered during first launch (the notice is mounted only after it). |
| Please drop an audio file | toast | `app/layout.tsx` | #119 | |
| Whisper downloaded but could not switch, Retry | notice | `components/TranscriptSettings.tsx` | #117 | Native retries the switch only. |
| No speech model, recording can't start | notice | `components/TranscriptSettings.tsx` | #117 | Also the Record button (#112). |
| CUDA driver notice | toast | `components/CudaReconfigurationNotice.tsx` | dropped | Release builds are CPU + Vulkan (owner decision 2026-11-24). |
| Meeting detected / call ended | toast | `app/layout.tsx` | dropped | Detection and auto-record dropped. |
| Recording toasts (start, pause, devices, mute) | toast | `components/RecordingControls.tsx` (6), `hooks/useRecordingStart.ts` (7), `hooks/useRecordingStop.ts` (5), `contexts/TranscriptContext.tsx` (6), `contexts/RecordingPostProcessingProvider.tsx` (2), `components/recording/RecordingPill.tsx` (1) | #112 | Counts are `toast` calls per file. |
| Meeting toasts (summary, copy, rename, delete, action items) | toast | `hooks/meeting-details/useSummaryGeneration.ts` (29), `hooks/meeting-details/useCopyOperations.ts` (11), `app/meeting-details/page-content.tsx` (7), `lib/meeting-actions.ts` (6), `components/meeting/MeetingHeader.tsx` (3), others (4) | #113 | Includes "Bilingual transcript detected". |
| Dialog toasts (import, enhance, export, templates, speakers) | toast | `components/MeetingDetails/TemplateEditorModal.tsx` (8), `RetranscribeDialog.tsx` (4), `components/people/SpeakerIdentityDialog.tsx` (4), `ImportAudioDialog.tsx` (3), `ExportMeetingsDialog.tsx` (2), `hooks/useImportAudio.ts` (1) | #119 | |
| Settings toasts | toast | `components/ModelSettingsModal.tsx` (12), `WhisperModelManager.tsx` (8), `ParakeetModelManager.tsx` (8), `RecordingSettings.tsx` (7), `DiarizationSettings.tsx` (7), `BuiltInModelManager.tsx` (6), `LocalStackStatus.tsx` (5), others | #117 | General and Recording ones (#114): `RecordingSettings.tsx`. Since #114 they report failures (saving, changing or opening the folder) and the folder change; the old "saved" toast after every change is gone, since the control shows the new value. |
| Person and contact toasts | toast | `app/person/page.tsx` (6), `components/people/*` (6) | #118 | |
| First launch toasts | toast | `components/onboarding/steps/DownloadProgressStep.tsx` (3) | #115 | |

## Persisted state

**Keep reading** marks the keys and files the new UI must read as they are,
name and value format
([UI_ARCHITECTURE.md › Native data](../UI_ARCHITECTURE.md#native-data)), so an
update to Frontend 2.0 loses no setting or data. sessionStorage dies with the
app process, so an update restart clears it anyway; it only has to work within
a session.

### localStorage

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `meetily_theme` | localStorage | `lib/app-theme.ts` (boot script, Settings, minibar) | #106 | **Keep reading.** `light`, `dark`, `system`; old values `midnight` and `charcoal` → dark, `vanilla` → light. Shared by both windows. |
| `meetily_user_name` | localStorage | `hooks/useUserName.ts`, `components/PreferenceSettings.tsx`, first launch | #114 | **Keep reading.** |
| `primaryLanguage` | localStorage | `contexts/ConfigContext.tsx` | #114 | **Keep reading.** Meeting language; default English for an English OS, else auto. Pushed to native at startup. |
| `showConfidenceIndicator` | localStorage | `contexts/ConfigContext.tsx` | dropped | Read only by the dead Show confidence setting. |
| `isAutoSummary` | localStorage | `contexts/ConfigContext.tsx` | #114 | **Keep reading.** Default on. |
| `summaryLanguageDefault` | localStorage | `lib/summary-language-preferences.ts` | #114 | **Keep reading.** Pinned summary language. |
| `summaryLanguageRecents` | localStorage | `hooks/useRecentLanguages.ts` | #119 | **Keep reading.** Picker recents. |
| `summaryLanguageFallback:<meetingId>` | localStorage | `lib/summary-language-preferences.ts` | #119 | **Keep reading.** The only copy for meetings without `metadata.json` (native answers `local_fallback`). |
| `detectedSummaryLanguageFallback:<meetingId>` | localStorage | `lib/summary-language-preferences.ts` | #113 | **Keep reading.** Detected-language cache for such meetings; losing it means detecting again. |
| `providerModelMap` | localStorage | `contexts/ConfigContext.tsx`, `components/ModelSettingsModal.tsx` | #117 | **Keep reading.** Last model per provider, seeded from the DB; restores the model when switching providers. |
| `meetily-labs-v1` | localStorage | `lib/labs.ts`, `lib/labs-features.ts` | #117 | **Keep reading.** The only store of Waveform scrubbing and Clean transcript; mirrors three native switches; `meetingAutomation` is ignored. |
| `meetily-speaker-edits:<meetingId>` | localStorage | `lib/live-speaker-edits.ts` | #112 | **Keep reading.** Speaker names given during a recording, replayed over recovery. `<meetingId>` is the IndexedDB recovery id `meeting-<ms>` minted at `recording-started` (`contexts/TranscriptContext.tsx`), not the saved meeting's id. The keys are never removed. |
| `af-live-notes` | localStorage | `lib/live-session.ts` | #111 | Not needed after the update. Notes typed during a recording (Markdown + BlockNote JSON), saved on Stop (#112). They survive only a reload of the window during the same recording: recovery never attaches them, the next start clears them, and an update never installs during a recording. For #112: after a failed notes save the old toast says to copy them from the Notes tab on the recorder, which is not shown outside a recording; make that draft reachable. |
| `meetily-intel-offer-dismissed` | localStorage | `lib/speech-choice.ts` | #117 | **Keep reading.** Devices whose Intel offer got "Not now". |
| `protocol-updater-seen-v1` | localStorage | `components/updater/UpdateToasts.tsx` | #113 | **Keep reading.** Update toasts already shown. |
| `meetily_export_link_style` | localStorage | `components/MeetingDetails/MeetingExportDialog.tsx` | #119 | **Keep reading.** `generic` or `obsidian`. |
| `downloading-models` | localStorage | `components/WhisperModelManager.tsx` | dropped | Not needed after the update. Native model status reports downloads. |
| `af-sidebar-group-by` | localStorage | `components/Sidebar/index.tsx` | dropped | Not needed after the update. No sidebar. |
| `af-meeting-notes-width` | localStorage | `app/meeting-details/page-content.tsx` | dropped | Not needed after the update. Tabs instead of a split. |
| `af-live-panel-open` | localStorage | `components/recording/LiveSession.tsx` | dropped | Not needed after the update. Tabs instead of a side panel. |

### sessionStorage

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `recording_started_at`, `recording_start_fallback_at` | sessionStorage | `hooks/useRecordingStart.ts`, `hooks/useRecordingStop.ts` | #112 | Not needed after the update. Start time sent as `recordingStartedAt`. |
| `last_recording_folder_path`, `last_recording_meeting_name` | sessionStorage | `contexts/RecordingPostProcessingProvider.tsx`, `hooks/useRecordingStop.ts` | #112 | Not needed after the update. From `recording-stop-complete`. |
| `indexeddb_current_meeting_id` | sessionStorage | `contexts/TranscriptContext.tsx`, `lib/live-speaker-edits.ts`, `hooks/useRecordingStop.ts` | #112 | Not needed after the update. Recovery id of the running recording. |
| `af-live-title` | sessionStorage | `lib/live-session.ts` | #112 | Not needed after the update. Title typed during the recording. |
| `pendingRecordingGroup` | sessionStorage | `lib/groups.ts` | #112 | Not needed after the update. A picker on the folder in the recording header (owner decision 2026-11-24). |
| `autoStartRecording`, `af-stop-requested` | sessionStorage | `lib/recording-launch.ts`, `hooks/useRecordingStart.ts`, `components/RecordingControls.tsx`, native `tray.rs` | #112 | Not needed after the update. Start/stop handoff across navigation. Native `tray.rs` no longer writes `autoStartRecording` (#110 emits `request-recording-toggle` instead), so nothing needs to read it. |
| `recovery_dialog_shown` | sessionStorage | `app/page.tsx` | #112 | Not needed after the update. Recovery offered once per session. |
| `post-call-processing:<meetingId>`, `post-call-summary-started:<meetingId>` | sessionStorage | `components/MeetingDetails/PostCallProcessingWorker.tsx`, `contexts/PostCallJobsContext.tsx`, `app/meeting-details/page-content.tsx` | #112 | Not needed after the update. Post-call pass and auto-summary run once per meeting. |
| `af-action-backfill-done` | sessionStorage | `lib/action-item-sync.ts` | #113 | Not needed after the update. Action-item backfill once per session. |
| `macos_system_audio_verified` | sessionStorage | `hooks/usePermissionCheck.ts`, `components/onboarding/steps/AudioTestStep.tsx` | #113 | Not needed after the update. macOS has no system-audio permission query; the audio test result stands in. |
| `meetily-settings-tab`, `meetily-settings-transcription-section`, `meetily-settings-transcription-provider` | sessionStorage | `app/settings/page.tsx`, `components/TranscriptSettings.tsx`, `RetranscribeDialog.tsx` | #110 | Not needed after the update. Route parameters replace them. |
| `meetily_chunk_reload` | sessionStorage | `app/layout.tsx` | dropped | Not needed after the update. Next.js chunk reload. |
| `af-chat:<key>` | sessionStorage | `components/chat/ChatThread.tsx` | dropped | Not needed after the update. AI chat. |
| `labsAutoStartPending`, `labsAutoRecordingProcess` | sessionStorage | `lib/meeting-automation.ts` | dropped | Not needed after the update. Auto-record. |

### Plugin stores and native files the UI reaches

Plugin stores live in Tauri's app data folder (`%APPDATA%\io.github.vmedvedevpro.protocol`
on Windows, `~/.local/share/io.github.vmedvedevpro.protocol` on Linux,
`~/Library/Application Support/io.github.vmedvedevpro.protocol` on macOS); the
other files sit in the install-local data root unless the row says otherwise.

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `recording-notice.json` › `permanentlyAcknowledged` | plugin-store | `components/RecordingNotice.tsx` (reads, writes) | dropped | Dropped by the owner decision 2026-11-24: the new UI neither shows the notice nor reads this store. |
| `preferences.json` › `show_recording_notification` | plugin-store | `components/RecordingSettings.tsx` (reads, writes) | dropped | Not needed after the update. Dead key (see Settings). |
| `onboarding-status.json` | plugin-store | native `onboarding.rs` via `get_onboarding_status`, `save_onboarding_status_cmd`, `complete_onboarding` | #115 | **Keep reading.** A completed first launch must stay completed. |
| `recording_preferences.json` | plugin-store | native `recording_preferences.rs` via `get/set_recording_preferences` | #114 | **Keep reading.** Read-modify-write. |
| `updater.json` | plugin-store | native `updater/prefs.rs` via `updater_set_auto_check` | #114 | **Keep reading.** |
| `store.json` › `authToken` | plugin-store | native `api/api.rs` | dropped | Not needed after the update. Dead helper (`#[allow(dead_code)]`). |
| `analytics.json` | plugin-store | none | dropped | Not needed after the update. Written by builds before #14; nothing reads it. |
| `notifications.json` | native file | `notifications/settings.rs` via `get/set_notification_settings` | dropped | Not needed after the update: desktop notifications are dropped (owner decision 2026-11-24); the new UI neither reads nor writes it. Native removal is #126. |
| `diarization_config.json` | native file | `diarization/mod.rs` via `set_diarization_engine`, `set_diarization_config` | #117 | **Keep reading.** |
| `voice_profiles.json`, `voice_profiles_enabled.txt` | native file | `diarization/voice_profiles.rs` | #118 | **Keep reading.** Voices and the Labs switch (#117). |
| `whisper_strict_silence.txt`, `parakeet_gpu_enabled.txt` | native file | `whisper_engine/labs.rs`, `parakeet_engine/labs.rs` | #117 | **Keep reading.** Labs switches. |
| `mcp-server.json` | native file | `meeting-library` `agent_access.rs` via `set_agent_access` | #117 | **Keep reading.** Next to the database. |
| `meeting_detection.json` | native file | `meeting_detection.rs` | dropped | Not needed after the update. Detection dropped; native keeps it unread. |
| SQLite `settings` and vocabulary tables | native DB | `api/api.rs` via `api_*config*`, `api_get_api_key`, `api_*vocabulary*` | #117 | **Keep reading.** Summary model, keys, live and after-meeting models, vocabulary. |
| Meeting `metadata.json` (summary language, detected language) | native file | `summary/metadata.rs` | #119 | **Keep reading.** Per meeting folder. |

### IndexedDB

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `MeetilyRecoveryDB` v1 › `meetings` (key `meetingId`; indexes `lastUpdated`, `savedToSQLite`) | IndexedDB | `services/indexedDBService.ts`; written by `contexts/TranscriptContext.tsx`, read by `hooks/useTranscriptRecovery.ts`, pruned by `app/page.tsx` | #112 | **Keep reading.** A recording interrupted before the update must still be recoverable after it. |
| `MeetilyRecoveryDB` v1 › `transcripts` (indexes `meetingId`, `storedAt`) | IndexedDB | same | #112 | **Keep reading.** Lines by sequence id. Old entries are pruned after 7 days, saved ones after 24 h, never while recording. |

## Native invariants the UI takes part in

| Item | Kind | Old file | Owner | Notes |
| --- | --- | --- | --- | --- |
| `src/lib/claude-output-limits.json` stays where native reads it | invariant | `lib/claude-output-tokens.ts`, native `summary/llm_client.rs` | #106 | Native compiles it in with `include_str!("../../../src/lib/claude-output-limits.json")`: the Claude output token limits shared with `lib/claude-output-tokens.ts`. Deleting `frontend/src` breaks `cargo build`; keep the file at that path or move it together with the include. Maximum summary length (#117) is validated against it. |
| WebView work holds a UI activity lease | invariant | `components/updater/UpdaterActivityReporter.tsx`, `contexts/PostCallJobsContext.tsx`, `lib/updater.ts` | #112 | `markUiActivity('recordingSave')` while the status is stopping, processing transcripts or saving; `markUiActivity('postCall')` while post-call jobs run. `updater_set_ui_activity` sends the set on change and every 60 s (native drops it after 150 s) and `[]` on unmount. Any new WebView-only long operation adds its own activity, which needs a native `UiActivity` variant first (an unknown name rejects the whole call), or an update can restart the app in the middle of it. |
| Native work registers itself | invariant | native `updater/busy.rs` | #112 | Recording, stopping, the save handoff, import, retranscription, summaries, onboarding, diarization and model downloads hold busy owners natively; the UI only shows state and never installs while one holds. |
| Updates download and install only on a click or quit | invariant | `lib/updater.ts`, `components/updater/*` | #114 | Download on **Download**, install on **Restart and update** or quit; the install gate decides. |
| Optional models activate only after a completed download | invariant | `contexts/OptionalModelDownloadsContext.tsx` | #117 | Whisper: `whisper_download_model(enablePostCall=true)` makes native save the after-meeting model; Nemotron: `download_diarization_models` activates natively and emits `diarization-engine-changed`. The UI never saves activation from a JS completion callback; it refreshes from `post-call-transcript-config-changed`, `diarization-engine-changed`, `optional-model-removed`, `model-download-activating`. Removal goes through `uninstall_optional_model`. `activateOptionalModel` in `lib/optional-model-activation.ts` is the JS-side activation this rules out; nothing calls it. |
| Whisper activation leaves the live model alone | invariant | `contexts/OptionalModelDownloadsContext.tsx` | #117 | Live and after-meeting defaults are independent. |
| Download jobs outlive navigation | invariant | `contexts/OptionalModelDownloadsContext.tsx` | #117 | Jobs are owned above the router, so leaving Settings or first launch does not cancel them. |
| Progress reaches 100 % only after verification | invariant | `components/shared/DownloadProgressToast.tsx` | #117 | Treat the complete event, not 100 %, as done. Integrity errors carry two 64-character hashes: wrap with `overflow-wrap:anywhere`; the UI matches "was deleted", "could not be deleted", "Nothing was deleted". |
| `You` comes from the microphone source | invariant | `utils/speakerUtils.ts`, `lib/speakerLabels.ts` | #112 | Never infer identity from a model's speaker number; `Speaker N` is meeting-local; the user's name only decorates `You` for display. |
| Speaker edits keep rows, text, timestamps and provenance | invariant | `components/people/SpeakerIdentityDialog.tsx`, `lib/live-speaker-edits.ts` | #119 | `reassign_transcript_speaker` with `from` changes one voice of an overlap row; `rename_meeting_speaker` renames for the meeting; rerunning diarization changes labels only (#113). Live edits are stored before the UI changes and replayed by sequence id (#112). |
| No silent engine substitution | invariant | `app/layout.tsx`, `components/DiarizationSettings.tsx` | #112 | Show `live-diarization-error`; keep source labels; never switch to another speaker engine. |
| Recording start order | invariant | `hooks/useRecordingStart.ts`, `lib/recording-launch.ts` | #112 | First launch done → `check_transcription_runtime` → load the live model (Parakeet or Whisper), reporting integrity failures and running downloads → automatic title (folder name and date, or day and time slot; see Automatic meeting titles) and pending folder → `start_recording_with_devices_and_meeting` → start timestamps. The recording state comes from `recording-started`, not from the call. The old UI also required the recording notice to be acknowledged (except for the tray Start); that gate is dropped (owner decision 2026-11-24). |
| Automatic meeting titles | invariant | `lib/meeting-titles.ts`, `lib/live-session.ts`, native `database/repositories/transcript.rs` | #112, #218 | An automatic title starts with `Meeting · ` ("Meeting · Mon, Sep 28 · 2:30 PM"). Since #218 the save passes `titleIsManual` (the session's `titleManual`) and native records it in `title_is_manual` without reading the text; a title the app made, the folder's ("Weekly Standup — Sep 28") included, gets the title the summary writes, while a typed title or a rename stays the user's. |
| Stop and save order (#32) | invariant | `contexts/RecordingPostProcessingProvider.tsx`, `hooks/useRecordingStop.ts`, `lib/recording-save.ts` | #112 | Every Stop (window, tray, minibar, quit) ends in native finalization, then `recording-stop-complete` with a `stop_id` to the main window; the listener lives there on every route. The WebView then: discards a take under 10 s (`discard_recording_folder`, answer `discarded`); polls `get_transcription_status` every 500 ms for up to 60 s until `!is_processing && chunks_in_queue === 0`, or the queue is empty and nothing happened for 8 s (a poll error ends the wait undone); waits 4 s for late lines unless the 60 s limit ran out (a poll error still waits), then on every path flushes the buffer and waits 500 ms; saves only after a completed wait: `api_save_transcript`, the pending folder, live notes, the pinned or detected summary language, the IndexedDB record marked saved; answers `recording_save_finished(stopId, 'saved')` before refreshing, and opens the meeting with `source=recording` only when that answer says the app is not quitting. A 60 s timeout or a poll error saves nothing: the status returns to idle, the answer is `notSaved` and the transcript stays in IndexedDB for recovery; keeping that branch is a #112 decision. Errors answer `failed`; native waits 120 s for an answer. |
| Post-call pass order | invariant | `components/MeetingDetails/PostCallProcessingWorker.tsx`, `contexts/PostCallJobsContext.tsx` | #112 | Retranscription → reload → diarization → reload → summary. Listeners register before the start call and filter by meeting id; jobs live above navigation; meetings without audio continue with the live transcript. |
| Meeting language lives in native memory only | invariant | `contexts/ConfigContext.tsx` | #114 | Push the saved `primaryLanguage` with `set_language_preference` at startup and on every change; locked during a recording. |
| Read-modify-write for native settings objects | invariant | `components/RecordingSettings.tsx`, `components/RecordingControls.tsx`, `contexts/ConfigContext.tsx`, `hooks/useAppAudio.ts` | #114 | `set_recording_preferences` replaces the whole object; fields the UI does not show must be written back unchanged (`set_notification_settings` did the same and is dropped with desktop notifications, owner decision 2026-11-24). Exception: `per_app_target_app` and `per_app_target_name` follow `per_app_targets` (see Settings › Legacy single app target). |
| A first launch creates the database | invariant | `contexts/OnboardingContext.tsx` | #115 | `check_first_launch` → import a legacy database (default location or Homebrew) or `initialize_fresh_database`, before anything reads meetings. |
| Starts wait for first launch | invariant | `app/layout.tsx`, native `tray.rs` | #110 | No start may run before first launch is done. The old notification starts waited for first launch and the recording notice; both are dropped (owner decision 2026-11-24). In the old app the tray Start was not gated in the WebView: native enables it once first launch is done or a Parakeet model exists, and its `autoStartRecording` flag survived the reload that ended first launch, so a recording could start right after it. The new tray event is heard only once first launch is done (#110). |
| Tray navigation stays client-side | invariant | `app/layout.tsx`, native `tray.rs` | #110 | A reload would drop a meeting still being saved and queued post-call jobs. `tray-navigate` routes client-side, and since #110 so does the tray Start (see Routes and windows). Paths native knows must resolve, or native changes with the router: `/settings` and `/settings?section=about` (`tray.rs`), `/minibar` (`minibar.rs`). |
| Minibar reads native time and owns no stop logic | invariant | `app/minibar/page.tsx` | #116 | Timer from `get_recording_state` (`active_duration`), not a local counter; Stop calls `stop_recording_from_minibar` and the main window saves. |
| One theme for both windows | invariant | `lib/app-theme.ts` | #106 | Paint before React from `meetily_theme`; `system` calls `setTheme(null)`, so Tauri passes OS changes through. |
| Summaries keep their stored formats | invariant | `lib/summary-markdown.ts`, `components/meeting/MeetingDocument.tsx` | #113 | `api_get_summary` can return a plain or double-encoded string, an object with `markdown` and `summary_json`, or the older section map (`_section_order`, sections of `{ title, blocks }`; `english_cache` and `original_markdown` are skipped). Read them all; save edits through `api_save_meeting_summary` as `{ markdown, summary_json }` with `userEdit: true`. `meeting-library` `summary_markdown` reads the same formats for AI agents. |
| Notes keep their stored format | invariant | `components/editor/NotesEditor.tsx`, `lib/blocknote-markdown.ts` | #111 | Saved as Markdown plus BlockNote JSON; summaries never overwrite notes. |
| A removed summary provider stays unselected | invariant | `contexts/ConfigContext.tsx`, `hooks/meeting-details/useSummaryGeneration.ts` | #117 | A saved provider native no longer offers loads as `provider: ''`; show "Select provider" and "Choose a summary provider" instead of defaulting to Ollama; such a refusal disarms the automatic summary (#113). |
| Which meetings recovery offers | invariant | `hooks/useTranscriptRecovery.ts`, `contexts/TranscriptContext.tsx` | #112 | Every unsaved IndexedDB meeting updated within 7 days and more than 2 s ago, once per session. The record is created at `recording-started`, before any line, so a meeting without lines is offered too and fails on Recover with "No transcripts found for this meeting"; filtering those out is a #112 decision. Audio is rebuilt from checkpoints when `has_audio_checkpoints` finds them. |
