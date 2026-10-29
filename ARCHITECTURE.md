# Architecture Notes

Practical notes on how this app fits together, aimed at someone (or some model)
opening the repo with no prior context. It deliberately focuses on the things
that are **not** obvious from reading the code — the traps, the "why is it like
this", and the places where a reasonable-looking change silently does nothing.

For build commands see [`frontend/build-cuda-env.bat`](frontend/build-cuda-env.bat).

For the recording/speaker implementation's file-by-file ownership, clocks,
worker lifecycle, model activation, and test entry points, also read
[`docs/DEVELOPMENT_MAP.md`](docs/DEVELOPMENT_MAP.md). Repository working conventions
are in [`AGENTS.md`](AGENTS.md); feature qualification and historical notes are
linked from that map.

---

## 1. Shape of the app

A Tauri 2 desktop app. Rust owns audio, transcription, storage and AI
orchestration; a Next.js 14 frontend renders the UI inside the webview. There is
no server — everything runs on the user's machine.

```
Next.js UI  ──invoke()──▶  Tauri commands (Rust)
     ▲                            │
     └──────── events ────────────┘      e.g. transcript-update,
                                          recording-audio-levels
```

The `backend/` directory in the upstream project (Python/FastAPI) is **not used**
and has been removed from this fork.

---

## 2. Audio pipeline

Windows VAD, Parakeet, and diarization share the pinned Microsoft ONNX Runtime
1.22 DLL initialized by `src-tauri/src/onnx_runtime.rs`. `ort/load-dynamic` is
Windows-only; never add a second ONNX runtime dependency. `build/onnxruntime.rs`
verifies exact archive/file hashes and stages the runtime for both packaging and
plain cargo builds. `tauri.windows.conf.json` preserves all fork resources and
adds `binaries/onnxruntime/*`; macOS/Linux resource lists are unchanged.
Record must initialize both source VADs before starting any saver or exposing a
chunk sender. Runtime failures return a distinct startup error, while recording
destination failures remain storage errors. All three source tracks, mute
alignment, and the 800 ms/2,000 ms live/offline policies still apply.
Whisper runs on whisper.cpp 1.8.3 through `whisper-rs` 0.16; what changed
with 1.8 is in the development map's
[Whisper engine](docs/DEVELOPMENT_MAP.md#whisper-engine) section.

Capture, recording, and transcription deliberately split into parallel paths in
`src-tauri/src/audio/`:

```
mic ─▶ normalize/limit ─┬─▶ mic VAD ─────▶ transcription worker
                       ├─▶ mic.mp4
                       └─┐
                         ├─▶ professional mix ─▶ audio.mp4 (playback)
sys ───────────────────┬─┘
                      ├─▶ system VAD ───▶ transcription worker
                      └─▶ system.mp4
```

### The mixed-audio trap ⚠️

Current live transcription receives **separate mic and system VAD segments**.
Mixing is only for `audio.mp4`, the user-facing playback track. Do not collapse
live STT back onto that mixed track: overlapping system speech can mask the
local user even when `mic.mp4` clearly contains their voice.

The old mixed-chunk `device_type = Microphone` placeholder can still appear in
legacy/import paths and must never be interpreted as speaker identity. Current
live source chunks preserve their actual capture source; final identity
refinement still comes from diarization (§4).

### Live audio levels

`pipeline.rs` computes per-source RMS/peak *before* mixing and emits them as
`recording-audio-levels` events (~25/sec per source), which drive the meters in
`RecordingControls`.

Mic and system speech use separate VAD instances. The mic path is intentionally
more permissive (`0.20/0.10`) than hot digital loopback (`0.50/0.35`). These mic
values were calibrated against the retained Logitech G733 track from the
"Vehicle Trade-In Discussion" failure: `0.42/0.30` and `0.30/0.20` found zero
speech, while `0.20/0.10` recovered 8 plausible segments / 16.9 seconds. Before
VAD, mic loudness normalization targets -20 LUFS, limits automatic gain to
0.5x-2.0x, smooths gain changes, and applies the user's gain before one final
-1 dB limiter. Do not move user gain after that limiter or restore unbounded
normalization; retained mic tracks showed hard 0 dBFS clipping under that design.

Microphone and system gain are separate persisted Rust-owned values. System
gain is applied once before source meters, system VAD/transcription, retained
`system.mp4`, and playback mixing. Over-range chunks are attenuated to a -1 dBFS
peak while preserving waveform shape, sample count, and source timing. Repeated
limiter activity is included in `recording-audio-levels` so both recording
windows can warn that the system gain or playback volume is too high. Do not
reimplement either gain only in the webview or in the final mixer.

Note: the webview **cannot** capture system audio itself, so browser-side
`getUserMedia` visualizers can only ever show the microphone. That is why the
levels come from Rust.

### Source-specific mute

Live microphone and system-audio mute are independent of each other and Pause.
Rust owns both atomic mute states, and the main window and separate minibar
recover them through `get_recording_state` plus their source-specific change
broadcasts. Capture streams stay open; muted-source samples are replaced with
zeros before levels, VAD, retained source tracks, and the mixer. Normal-sized
silent chunks must keep flowing so the other source remains live and
`mic.mp4`, `system.mp4`, and `audio.mp4` retain the same timeline. Never
implement either mute by dropping callbacks, stopping a device, or only hiding
the frontend meter.

### Live segmentation and shutdown invariants

- Live VAD redemption is 800 ms. Offline retranscription uses 2,000 ms because
  it has no live-latency constraint.
- Some capture backends suppress callbacks throughout exact-zero silence. Live
  inactivity is tracked per source; after 800 ms Rust force-finalizes only that
  source's active utterance without synthesizing audio. It then replaces the
  Silero session to release internal history and offsets the fresh session's
  timestamps onto the continuous meeting timeline. Do not use wall-time-sized
  silence buffers or one shared mic/system activity clock.
- Every window, including exact zero-filled padding, must handle the segments
  returned by `ContinuousVadProcessor`. Speech-end commonly arrives during the
  trailing silent window; discarding that return drops the whole utterance.
- Whisper's current `confidence` is text-length-derived, not a token
  probability. It is diagnostic and must not filter short valid phrases.
- During shutdown `RecordingManager` is temporarily outside its global slot.
  The transcript listener owns a cloned shared segment handle so final events
  remain writable until the worker finishes.
- Timed-out workers are aborted and awaited before listener removal and model
  unload. Dropping a Tokio `JoinHandle` only detaches it.
- Transcript-only sessions still write their final segment vector even when
  audio auto-save is disabled.

### Compact recording bar ownership

The floating bar is a separate `minibar` webview, so it cannot share React
recording state with `main`. Rust owns its lifecycle in `src-tauri/src/minibar.rs`:

- `MINIBAR_LIFECYCLE` serializes create/hide/destroy transitions because Windows can
  report one minimize through more than one observer.
- A new bar is built hidden; Rust hides `main` before showing the bar so both
  control surfaces never flash onscreen together.
- `recording_commands::stop_recording_inner` is the only native stop owner and
  the only source of `recording-stop-complete`. A minibar-origin Stop hides the
  bar immediately after claiming `IS_STOPPING`, then Rust destroys it after the
  command returns so Tauri can safely send the IPC response. Tray and frontend
  code must not emit a second completion event.
- Only Stop originating in the minibar restores the main window it hid. A tray
  or already-visible main-window stop must not steal focus. A quit during a
  recording (`quit.rs`) is the exception: it leaves compact mode through
  `exit_compact_mode` before it asks, so the question and the save that
  follows show in the main window.
- The minibar polls Rust `RecordingState.active_duration` every 500 ms rather
  than incrementing a webview-local timer. This keeps it aligned across startup
  delay, duplicate minimize events, and pauses. `recording_duration` is only a
  compatibility fallback.

Do not restore cross-webview stop-request events, elapsed-time reseeding, or a
frontend close fallback. Those mechanisms caused zombie bars, frozen
`Finishing` states, timer resets, and duplicate post-processing.

Dragging uses one bubbling mouse handler that excludes buttons and their children,
plus a minibar-only `core:window:allow-start-dragging` capability. Container-only
`data-tauri-drag-region` attributes miss child targets in Tauri's native handler.

### Windows runtime ownership

The workspace pins a vendored `tauri-runtime-wry` 2.12.3 through the root
`Cargo.toml` (the patch was first written for 2.11.4 and ported with the
Tauri 2.12 update). A v0.2.12 long-recording crash matched the upstream Windows
`Rc<EventLoopRunner>` clone/drop race: ordinary background IPC traffic can
corrupt the event-loop reference count. This is not fixed by slowing the
minibar timer, changing transcription models, or replacing Tao's `Rc` with
an `Arc` while ignoring thread-affine destruction.

The Windows patch keeps the strong target owner inside the non-Send `Wry`
runtime; cloned contexts hold private atomic weak references. Only UI-thread
dispatch upgrades them, monitor queries are routed to that thread (upstream
does this itself since 2.12), and the owner expires before native-loop
destruction, including panic unwinding.
Windows display handles borrow no data. Non-Windows behavior is unchanged,
except that a lost reply to a runtime-handle monitor or cursor query is an
error or is dropped instead of a panic, on every platform (upstream's 2.12 code
for these queries is shared). Windows runtime `tracing` is deliberately
rejected because its separate `ActiveTraceSpanStore` still contains another
cross-thread `Rc`.

See `vendor/tauri-runtime-wry/PATCH.md` for provenance, regression commands,
scope, and removal criteria. Do not remove this override on a version bump
without verifying an equivalent upstream ownership fix. Short native stress
tests do not establish multi-hour recording/minibar stability. For v0.2.14 the
reporting user approved release after a successful patched-build trial so far;
its duration is unconfirmed and no completed multi-hour soak is claimed.

---

## 3. Where things are stored

This fork is install-local on Windows and Linux. On macOS, core writable data is
under `~/Library/Application Support/vmedvedevpro/Protocol`; Tauri plugin stores use the app
identifier directory `~/Library/Application Support/io.github.vmedvedevpro.protocol`. Both are
outside the signed `.app`, because writing inside that bundle invalidates its
signature.

`src-tauri/src/paths.rs` is the single source of truth:

| What | Where |
|---|---|
| Database, templates, models, file-backed settings | Windows/Linux: `<exe dir>/data/…` (OS data dir `…/vmedvedevpro/Protocol` if not writable); macOS: `~/Library/Application Support/vmedvedevpro/Protocol/…` |
| Tauri plugin stores (recording preferences/onboarding) | Windows: `%APPDATA%\io.github.vmedvedevpro.protocol\…`; macOS: `~/Library/Application Support/io.github.vmedvedevpro.protocol/…` |
| Diarization models | Pyannote/WeSpeaker: bundled in the platform app bundle's `resources/diarization/`; a repaired or user-supplied copy in `<data>/models/diarization/` takes precedence. Nemotron-3: downloaded to `<data>/models/diarization/` only |
| **Audio recordings** | Windows: `%USERPROFILE%\Music\protocol-recordings\<meeting>`; macOS: `~/Movies/protocol-recordings/<meeting>` |

Two gotchas:

1. **Recordings are the exception.** They follow the user's configured
   recordings folder (`audio/recording_preferences.rs`), *not* the data root,
   and they are **`.mp4`, not `.wav`**. New recordings retain aligned
   `audio.mp4` (mixed playback), `mic.mp4` (local user), and `system.mp4`
   (remote/computer audio). Code that looks for playback must prefer
   `audio.mp4` — see `diarization::find_meeting_audio`.
2. `paths.rs` always uses the OS data directory on macOS. Windows and Linux fall
   back there if the install directory isn't writable.

Recording-folder creation is intentionally collision-safe. Sanitized titles are
not unique, so `audio_processing.rs` creates the directory atomically and adds a
suffix if it already exists. The configured custom recordings root must flow
through `RecordingManager` into every saver; falling back to the default root at
save time makes Settings appear to work while files go elsewhere. The short-take
discard command canonicalizes paths, rejects every allowed root itself, and only
deletes descendants of the configured, default, or legacy portable roots. Keep
the equality rejection separate from descendant checks because roots may be
nested.

The native folder picker persists a destination only after it can be created and
written. On macOS, validation must reject the `.app` bundle and every descendant
before creating anything so a writable user-installed application cannot
invalidate its signature.

Required mixed-audio failures are not allowed to fail silently. FFmpeg process
failures, timeouts, and missing mixed outputs propagate through
`RecordingManager` into the `recording-stop-complete.audio_save_error` payload.
The frontend keeps the transcript flow running and shows a ten-second error
toast. Empty or failed optional mic/system tracks are currently logged and
omitted because either source may remain silent for a whole meeting. Concat
demuxer list entries use `ffconcat_file_line`; raw absolute paths are unsafe
because an apostrophe in a custom root or user name terminates FFmpeg's quoted
path.

A one-time migration (`paths::migrate_legacy_data`) copies data from the old
Tauri app-data location on first run so upgrading users keep their history.

### Crash reports

`src-tauri/src/crash_report.rs` writes a small session marker under
`<data>/crash-reports`. A marker left behind after process termination becomes a
pending unexpected-exit report on the next launch; the panic hook also writes a
source-relative location and anonymous fingerprint. Clean shutdown removes only the current session's
marker. This detects abrupt exits without trying to allocate a ZIP inside a
failing process. If failures repeat before the prompt is resolved, the newest
failure replaces the older pending report.

After onboarding is resolved, `app/layout.tsx` checks for that pending report
before mounting the application provider tree. This prevents service probes,
meeting loads, and transcript/audio recovery from running behind the prompt.
The dialog has exactly **Send Report**, **Save
ZIP**, and **Ignore**. Send Report creates the same local ZIP and opens a
prefilled public GitHub issue for manual attachment because the project has no
report-upload server; nothing is uploaded automatically.

The in-app ZIP is deliberately allowlist-only: crash classification/time,
version/backend, OS family and major version, architecture, bucketed CPU core
count, rounded memory size, source-relative panic file/line details, and a
panic-location fingerprint. It
never includes ordinary logs, recordings, checkpoints, transcript/summary data,
meeting identity, SQLite/WebView/settings storage, credentials, usernames,
hostnames, or device names. It is the only supported crash-reporting path. The
manual support-bundle script inherited from upstream was removed because it
zipped the SQLite database (provider API keys are stored there in plaintext),
WebView storage, memory dumps, the newest meeting recording (copied unless
`--no-recording` was passed), the computer and user names, and the command lines
of running app processes; do not add a broader collector back.

Nothing in the repository collects native-crash evidence (exception code,
faulting module, stack) any more, so a native fault that is not a Rust panic
yields only an `unexpected_exit` report. For such a crash, ask the user for the
matching Windows Application event log entries, the WER `ReportArchive` and
`ReportQueue` folders, dumps in `%LOCALAPPDATA%\CrashDumps` (written only when
WER LocalDumps is enabled), and `<data>\crash.log`. The panic hook still appends
the panic message and sanitized backtrace to that file (for an installed Windows
build, `%LOCALAPPDATA%\vmedvedevpro\Protocol\data\crash.log`); it stays as the
local manual-debugging file and is never added to the ZIP.

---

## 4. Speaker diarization ("who spoke when")

The default remains the bundled Pyannote/WeSpeaker pipeline described below.
Settings also offers optional **Nemotron-3** for live labels and post-call **Auto-detect**. An
explicit speaker count is available only when Pyannote is selected. Nemotron
always auto-detects, ignoring stale count requests without switching engines;
never simulate a count by truncating its eight output channels. The live engine
is selected at recording start. Pyannote uses the existing per-turn embedder;
Nemotron receives continuous resampled system audio through the observer in
`vad.rs`, before VAD removes silence. `live_nemotron.rs` owns a dedicated inference
thread, bounded input queue, and recording-relative speaker timeline. Do not feed
concatenated VAD speech turns into its streaming state. Microphone audio remains
`You`. Closing streaming input drains and flushes audio; releasing the timeline
waits until transcription processing finishes. See the development map for timing
units, overload behavior, and the distinction between `finish()` and `stop()`.

`diarization/nemotron.rs` adapts the attributed MIT-licensed Sortformer reference
under `diarization/sortformer/` to the shared ONNX Runtime. Windows bundles the
DirectML-enabled runtime and pinned DirectML redistributable, with an absolute-path
dependency preload. Nemotron attempts DirectML on adapter 0, using sequential
execution with memory patterns disabled, then recreates a CPU session if GPU
session initialization fails. VAD and Parakeet retain CPU sessions. Its native
feature extraction differs from Parakeet's `nemo128.onnx`; never substitute that
preprocessor. Preserve per-speaker activity, lookahead, and speaker-aware cache
compression. Rolling recent history alone cannot retain a long-absent speaker.
Weights and their license download from a pinned revision with exact size and
SHA-256 checks. Both downloaded and manually supplied models are verified before
loading. The code license ships with the bundled diarization resources.

Diarization updates speaker labels only, in one transaction. It must never
delete split rows, shorten the original text, or infer sentence timestamps from
character/byte proportions. Unknown local-user identity remains unknown; arrival
order or the longest speaking duration is not evidence of "You".

Implemented from scratch on the ONNX Runtime already in the build (`ort`),
deliberately **not** by linking sherpa-onnx — that would pull in a second
onnxruntime and risk duplicate-symbol failures at link time.

`src-tauri/src/diarization/`:

| File | Role |
|---|---|
| `dsp.rs` | WAV reader + Kaldi-compatible 80-dim log-mel fbank (Povey window, pre-emphasis 0.97, HTK mel, per-utterance CMN) |
| `models.rs` | pyannote `segmentation-3.0` (7-class powerset) + WeSpeaker ResNet34 embeddings + VBx LDA transform; reads each ONNX file's input/output names and refuses another interface at load; includes a minimal `.npz`/`.npy` reader |
| `clustering.rs` | Agglomerative clustering, cosine distance, average linkage |
| `mod.rs` | Offline pipeline + Tauri commands |
| `online.rs` | Live engine selection and Pyannote/WeSpeaker per-turn clustering |
| `live_nemotron.rs` | Continuous Nemotron worker, timeline lookup, and shutdown lifecycle |
| `download.rs` | Repair-path model download from each file's public source at a pinned commit |
| `retired.rs` | Startup removal of the 0.3.0 model copies in `<data>/models/diarization/`, by SHA-256 only |
| `qualification.rs` | Test-only: model-file comparison on public fixtures (ignored) and the voice-profile space pin |

### Offline pipeline

1. New recordings load `mic.mp4` and `system.mp4` independently. The mic track
   is deterministically the local user; only system audio is clustered into
   remote speakers. Older meetings fall back to mixed `audio.mp4` plus the
   enrolled user voiceprint. Decode/downmix/resample inputs to 16 kHz.
2. Slide a 10 s window; run segmentation; decode the powerset output into
   per-frame activity for up to 3 *local* speakers.
3. Embed each local speaker's audio in each window.
4. Cluster embeddings globally → *global* speaker identities.
5. Merge adjacent same-speaker regions.

The mic track updates `<data>/voiceprint/user_voiceprint.json`; live
Pyannote diarization seeds the user centroid from that profile on later calls.
Overlapped speech remains excluded from embeddings, but overlap timing is
retained. Transcript rows can carry combined labels such as
`You + Speaker 1` rather than being forced to one voice.

Two non-obvious refinements, both from real failure cases:

- **Overlapped speech is excluded from embeddings.** Powerset segmentation
  assigns simultaneous frames to *every* active speaker; including them blends
  two voices into both embeddings.
- **Only turns ≥1.5 s may define a cluster.** Short fragments (usually speech
  clipped by a window edge) have noisy embeddings and used to spawn phantom
  speakers. They are still labelled, by nearest centroid.

### Calibration, and its limits

`DEFAULT_THRESHOLD = 0.60`, chosen by measurement against recordings with known
speaker counts, not by guess:

| Recording | Truth | Auto |
|---|---|---|
| Solo presenter | 1 | 1 ✅ |
| Team call | 5 | 5 ✅ |
| Panel | 6 | 8 |
| Interview | 3 | 2 |

**A single threshold cannot fit every recording** — how far apart two voices
land depends on mic, codec and room. The chosen value never invents speakers in
single-speaker audio, which is the worst failure mode. When the count is known,
passing `num_speakers` bypasses the threshold and resolved *every* test case
exactly. The post-call dialog therefore recommends an entered count, but offers
threshold-based **Auto-detect** when the user does not know it.

A silhouette-based automatic speaker-count search was tried and **removed** — it
consistently preferred the maximum candidate count and did worse than a fixed
threshold. Don't re-add it without evidence.

### Headless evaluation

Diarization can be evaluated without launching the GUI:

```bat
set DIARIZE_WAV=C:\path\to\audio.wav
set DIARIZE_MODELS=frontend\src-tauri\resources\diarization
build-cuda-env.bat test diarize_sample
```

Optional: `DIARIZE_SWEEP=0.55,0.60,0.65` (threshold sweep in one process),
`DIARIZE_SPEAKERS=4` (force count), `DIARIZE_DIAG=1` (embedding-distance
histogram — should be clearly bimodal if features are healthy).

Roughly 80× realtime on CPU.

---

## 5. Transcript rendering (frontend)

The most error-prone area in the codebase, because of duplicated components.

```
live screen        → app/_components/TranscriptPanel.tsx        ─┐
                                                                 ├─▶ VirtualizedTranscriptView
meeting details    → components/MeetingDetails/TranscriptPanel  ─┘
```

Two traps, both of which have bitten:

1. **Two components named `TranscriptPanel`.** Editing the wrong one compiles
   and does nothing visible.
2. **Three separate transcript→segment converters**, and every one must copy
   `speaker` or labels silently vanish on that screen:
   - `app/_components/TranscriptPanel.tsx` (live)
   - `components/MeetingDetails/TranscriptPanel.tsx` (non-paginated)
   - `hooks/usePaginatedTranscripts.ts` (paginated)

(A third, unrendered `components/TranscriptView.tsx` used to exist and caused
exactly this confusion; it has been deleted along with `SettingTabs.tsx`,
`CustomDialog.tsx` and the never-compiled `src-tauri/src/audio_v2/`.)

The label also has to survive the Rust side: `MeetingTranscript` must include
`speaker`, and every place constructing it must set it.

`components/meeting/MeetingDocument.tsx` renders the complete stored Markdown
(`completeSummaryMarkdown` in `lib/summary-markdown.ts`) as its authoritative summary.
English-keyword action/topic shortcuts are supplemental only; never make them the
sole visible representation, because custom and non-English headings do not map
reliably to those buckets. Preserve Markdown whitespace, nesting, and table syntax.

### Stable speaker colors

`VirtualizedTranscriptView.tsx` owns identity colors for both screens. `You` and
labels ending in `(You)` normalize to the same reserved blue, right-aligned user
identity. Blue is excluded from remote colors: Speaker 1 is purple, Speaker 2
emerald, followed by amber, pink, and cyan. Dot and text colors share one index
function, and normalized identity is also used when adjacent turns merge.

### Global search and durable people

`GlobalSearchDialog.tsx` is the single global search surface. The expanded
sidebar field, collapsed Search icon, and `Ctrl/Cmd+K` dispatch/open that same
dialog; the old sidebar-only meeting filter has been removed. It invokes
`api_global_search`, which returns typed `person`, `meeting`, `transcript`, and
`summary` rows. Summary matching parses only user-visible markdown/BlockNote/
legacy content, never raw JSON or hidden `english_cache`. `/person?id=...` is a
query-driven static route because local SQLite people cannot be known during a
Next static export.

The migration `20260811000000_add_people.sql` adds:

```text
people(id, display_name, normalized_name, notes, created_at, updated_at)
person_speakers(person_id, meeting_id, speaker_label)
```

Migration files are immutable byte-for-byte after release. SQLx hashes the raw
SQL, including line endings. Historical migrations through 2025 intentionally
retain their platform checkout behavior because Windows and macOS releases
embedded different line endings; never normalize those files retroactively.
Every new migration must instead receive an explicit LF entry in
`.gitattributes` before release. Windows `0.2.5` and `0.2.6` accidentally
embedded LF and CRLF variants of the same people migration. Database startup
may repair only those two known hashes, and only after verifying the exact
people table/index definitions; never generalize that exception to arbitrary
migration mismatches.

Identity is explicit through `person_speakers`; never infer one person from
`Speaker N`, capture-source placeholders (`mic`, `system`, etc.), `Guest`, `You`,
or combined overlap labels. Existing custom labels are backfilled and exact
normalized names auto-link across meetings. A meeting-local rename must split a
shared profile when the new name is not already a known person; it must not
silently rename that person in every other meeting. Removing a name deletes the
mapping and restores the lowest available `Speaker N` label. Blank Save and the
explicit **Remove name** action share this operation.

Retranscription replaces transcript rows, so it also deletes that meeting's
person mappings and prunes orphan people in the same transaction. Meeting
deletion performs the same explicit cleanup even if SQLite foreign-key
enforcement differs across legacy databases.

Person Q&A is loaded in Rust by `ask_person`; React never supplies its own
corpus. Context contains only the person's mapped messages plus user-visible
summaries for those meetings, is capped conservatively at about 24,000
characters, treats source text as untrusted, and asks for meeting/date/time
citations. Cloud model selections receive that selected context, which the
profile UI discloses; local providers keep it on-device.

### Automatic post-call pipeline

`source=recording` transfers control to `PostCallProcessingDialog.tsx`:

```text
save live meeting and retained tracks
  -> ask for total speakers (exact count recommended; Auto-detect optional)
  -> retranscribe mic.mp4 and system.mp4 independently, unless skipped with X
  -> refetch replaced transcript rows
  -> diarize using the selected exact count or threshold-based Auto-detect
  -> refetch persisted labels
  -> if Auto Summary is enabled, summarize fresh SQLite transcript rows
  -> otherwise leave the summary empty for manual generation
```

Enhanced retranscription must carry retained-track provenance into every new
row: mic speech starts as `You`, system speech starts as `Guest`, and mixed-only
fallback speech remains unlabeled. The later dual-track diarization pass may
refine `Guest` to `Speaker N`, but it must not erase the deterministic mic
identity when segmentation finds only part of a short utterance. When source
speech overlaps, canonical combined labels begin with `You` (for example,
`You + Speaker 1`) so user styling and identity normalization remain stable.
These hints are trusted only when that diarization run actually used both
retained source tracks; legacy mixed recordings must still rely on clustering
and voiceprint evidence.

Do not start automatic diarization without the user's explicit Auto-detect
choice, or generate a summary before this sequence. The count-prompt X skips
only retranscription: it keeps the live rows, still runs the selected exact or
automatic diarization, refetches labels, and then releases the post-call
completion gate. The Auto Summary preference decides whether that completion
starts a summary.
Register retranscription listeners before invoking Rust,
filter events by meeting ID, and clean them once. Model fallback stays within the
configured local provider. Timeout cancellation waits for the native reservation
to clear before retry. Pre-diarization and post-diarization refresh failures are
distinct retry stages. Workflow refetch failures reject without replacing the
already-mounted page with its initial fatal-load screen.

When Auto Summary is enabled, summary generation is gated by both the initial
summary lookup and post-call completion. It fetches all current rows directly
from SQLite, not the paginated React page. With Auto Summary disabled, post-call
processing still completes and the empty summary remains available for manual
generation. Both success-toast and delayed navigation paths must preserve
`source=recording`. Completed meeting IDs are recorded in `sessionStorage` to
prevent React remount duplication.

Post-call summary start uses two levels of ownership: a module-level in-flight
promise deduplicates React remounts/StrictMode while setup is running, and
`post-call-summary-started:<meeting>` is persisted only after
`api_process_transcript` returns a valid process ID. Preflight, model, transcript
fetch, or invoke failures clear the provisional claim and end auto-summary for
the page (`onAutoGenerateComplete`), so neither a re-render nor a provider only
selected in Model Settings starts it again; the next run starts from **Generate
summary** or **Try again**. Do not mark summary start before backend acceptance.

If audio saving was disabled or retained audio is unavailable, enhancement and
diarization are impossible. The error state offers **Use live transcript**, which
refetches the saved live rows and unblocks the sequence instead of trapping the
user in a retry loop. Those rows are summarized only when Auto Summary is
enabled or the user generates a summary manually.

Claude summary output uses the optional `summaryMaxTokens` setting and a shared
Rust/UI catalog in `src/lib/claude-output-limits.json`. The application default
is 8,192 tokens (4,096 for original Claude 3), not the model's maximum. Explicit
values must be positive integers within the catalog/application limit. Resolve
the effective default before cache fingerprinting; do not let this setting leak
into Custom Server or other providers. Claude responses must report a completed
stop reason; `max_tokens`, refusal, or missing completion must fail before an
incomplete summary is persisted or cached.

Summary prompts serialize every persisted transcript row with timestamp,
speaker label, and text. This is required for a regeneration after speaker
rename to actually expose the renamed identities to the model. Generated
meeting titles are written through `api_save_meeting_title` before meeting and
sidebar refetches; a local-only title is otherwise immediately replaced by the
stale database value. Meeting export owns content selection first (transcript,
summary, or both) and format selection second. It always fetches all transcript
rows from SQLite, and summary export must support markdown, BlockNote
`summary_json`, and legacy section representations.

File export is native-owned after format selection. `exportSummary.ts` creates
PDF/DOCX/text bytes, opens `@tauri-apps/plugin-dialog` Save, then writes only the
user-selected path through `@tauri-apps/plugin-fs`; cancellation is silent.
Clipboard export remains immediate. Do not restore browser Blob/anchor downloads,
which bypass the requested destination and behave inconsistently in a webview.

---

## 6. Model sources

Transcription and summary models come from the model catalog,
`model-catalog/catalog.json` on `main` (embedded in every build, fetched daily;
see [docs/MODEL_CATALOG.md](docs/MODEL_CATALOG.md)). Each entry names a Hugging
Face repository and files; the commit (or the entry's pinned `revision`) and
every file's exact size and SHA-256 are read from the Hugging Face API when a
model is downloaded, and downloads use `resolve/<commit>/<path>`, never a
branch. The sizes a model list shows also come from Hugging Face (one tree
listing per repository, asked for when the list is shown, kept in the cache
and refreshed by the daily check) or, for an installed model, from its install
record; an unknown size is not shown. Diarization models stay pinned in `src-tauri/src/model_integrity.rs`,
whose module comment records how each hash was obtained. There are no mirrors.

| Model | Source |
|---|---|
| Whisper | Hugging Face `ggerganov/whisper.cpp` (catalog) |
| Parakeet v2, v3 (INT8) | Hugging Face `istupakov/parakeet-tdt-0.6b-{v2,v3}-onnx` (catalog) |
| Qwen / Gemma | Hugging Face `unsloth/Qwen3.5-{2B,4B}-GGUF`, `bartowski/google_gemma-3-{1b,4b}-it-GGUF` (catalog) |
| Pyannote segmentation-3.0 | Bundled; Hugging Face `onnx-community/pyannote-segmentation-3.0` @ `733a93b` `onnx/model.onnx` (float32) |
| WeSpeaker ResNet34-LM | Bundled; Hugging Face `Wespeaker/wespeaker-voxceleb-resnet34-LM` @ `f0c48c2` |
| VBx x-vector transform | Bundled; Hugging Face `pyannote-community/speaker-diarization-community-1` @ `8a52737` `plda/xvec_transform.npz` |
| Nemotron-3 | Hugging Face `altunenes/parakeet-rs` @ `4d2a8bc` |

Installed models are updated in place when Hugging Face's files change: the
new version is downloaded beside the old one, checked, test-loaded by its
engine and swapped under a journal; any failure keeps the old one.

The three bundled diarization files are byte-identical to those public files,
and the Settings repair download takes each from its source. Until 0.3.0 the
two ONNX files were the previous fork's own exports with no public source; the
qualification of the swap (issue #23) and how to repeat it are in
[docs/DIARIZATION_MODELS.md](docs/DIARIZATION_MODELS.md).

The installer redistributes the three Pyannote files, so their notices ship
beside them in `resources/diarization/THIRD_PARTY_MODELS.txt`: segmentation-3.0
is MIT (Copyright (c) 2023 CNRS, full text included), and the WeSpeaker
ResNet34-LM weights and `xvec_transform.npz` are CC BY 4.0. The file names each
source, its authors and the ONNX conversion. The Windows release verifier checks
that the payload's `resources/diarization/` holds exactly these files and the
notices, byte for byte; the macOS leg checks the app bundle and the Linux leg
both the deb and the AppImage for the same five files. When a bundled model
changes, update this file and the Settings credit line together. The other
models are downloaded by the user from the sources above and are not
redistributed, so they need no notices.

Integrity checks:

- **Download.** The SHA-256 is computed while the file streams in
  (`model_integrity::Check`, bounded by the pinned size). A resumed Parakeet or
  summary download first re-reads the bytes it keeps, and checking that kept
  part, or a complete file already on disk, stops at once on Cancel. A mismatch
  deletes the file and the error says so ("… failed its integrity check and was
  deleted"), or says it "could not be deleted" with the OS error. A server that
  announces another length is refused before anything is written ("Nothing was
  deleted"). The shared download toast shows each of these as "Integrity check
  failed" with the matching outcome. Progress stays below 100% while bytes
  arrive; 100% and "Download completed" follow a matching hash.
- **Startup.** Discovery checks only the exact size of the installed version
  (its install record, or the 0.3.0 pin for a 0.3.x install), so startup never
  reads gigabytes. A file that failed and could not be deleted carries a
  `<file>.rejected` marker, and discovery does not list it as installed.
- **First load.** A successful check writes `<file>.verified` beside the model
  (pin, size, modification time). Before Parakeet, Whisper or llama.cpp parses a
  model, `ensure_verified` accepts a valid marker after two metadata reads and
  otherwise hashes the file once, off the async runtime: models installed by an
  older build, or changed since their download. A full-size file that does not
  match is deleted and the load fails with the reason. A file of another size
  is refused and kept: it may be a partial download kept for resume or one being
  written. The built-in summary path, which the live assistant reaches without
  a readiness check, also refuses while the model is downloading, and after a
  deletion marks the model failed, with the reason, so Settings offers it again.
  It logs every refusal with the model name, as an error when the content did
  not match.
- Diarization keeps its own checks: downloads go to `.part`, are verified and
  then renamed; Nemotron is hashed before every load (`nemotron.rs`); bundled
  or manually placed Pyannote files are not hashed at load.

### Summary providers

Summaries and the live assistant run on the built-in GGUF models, Ollama, or an
HTTP API provider (Claude, OpenAI, Groq, OpenRouter, Custom Server);
`llm_client::LLMProvider` lists them. Protocol removed upstream's Claude Code
CLI provider, which ran the user's `claude` executable from a path the WebView
could choose ([#19](https://github.com/vmedvedevpro/Protocol/issues/19)). No IPC
command runs an executable chosen by the user any more; Built-in AI still starts
the bundled `llama-helper` sidecar, and the Ollama model check may run
`ollama list`.

Settings saved while that provider was selected still load:

- `api_get_model_config` (`read_model_config`) returns any saved provider that
  `LLMProvider::from_str` rejects with an empty provider and model, keeping
  `whisperModel`, `ollamaEndpoint` and `summaryMaxTokens`. The frontend reads
  `provider: ''` as no provider selected: `ConfigContext` adopts it instead of
  its Ollama default, Model Settings shows **Select provider** with a hint and
  keeps Save disabled, and generating or regenerating a summary shows **Choose a
  summary provider** (one toast with a fixed id) without calling the backend.
  The hook's `onOpenModelSettings` then opens the meeting page's Model Settings
  dialog: `MeetingDocument` points the page's `openModelSettingsRef` at it, which
  also serves the Ollama and built-in model checks. A refused regeneration keeps
  the regenerate dialog, the **Edited** badge and the replace warning:
  `handleRegenerateSummary` resolves `true` only when the backend accepted a
  run. The live assistant answers "No AI model configured" for the same row.
- After a recording, `keepsSavedSummaryModel` (`lib/meeting-summary-policy.ts`)
  counts such a row as configured, so the summary attempt asks for a provider.
  That refusal ends auto-summary for the page, like any post-call attempt that
  starts no run; the user saves a provider and clicks **Generate summary**. The first-run gemma3:1b fallback still applies only when there is
  no settings row or the saved provider has no model.
- Migration `20260914000000_add_claude_cli_path.sql` stays, because sqlx refuses
  to start when an applied migration is missing. The `settings.claudeCliPath`
  column it adds is no longer read or written.
- The provider's working folder `<data root>/claude-cli`, which held only
  temporary system-prompt files, is deleted at startup
  (`paths::remove_claude_cli_working_dir`). A failure is logged and does not
  stop startup; the next start tries again.

Tests: native `api::model_config_tests`, `live_assistant::assistant_model_tests`
and `paths::retired_dir_tests`; frontend
`tests/hooks/summary-provider-unavailable.test.tsx`,
`tests/meeting-details/summary-provider-prompt.test.tsx` (the meeting page with
the real ConfigContext, summary hook and MeetingDocument: auto-summary disarm,
the Model Settings dialog, a refused regeneration) and
`tests/lib/meeting-summary-policy.test.ts`.

---

## 7. Building

`frontend/build-cuda-env.bat` sets up MSVC + LLVM + the reassembled CUDA toolkit
for CUDA development builds:

| Mode | Purpose |
|---|---|
| `check` | Type-check only, no link — **safe while the app is running** |
| `lib` | Full build + stage bundled resources next to the exe |
| `test <name>` | Run a Rust test with output shown |
| `bundle` | Retired: CUDA installers are not supported, the mode stops with a message |

The installer carries only the CPU and Vulkan builds and no CUDA runtime (#15),
so a CUDA `protocol.exe` packaged by Tauri would not start; the Windows
installer is built by `frontend/scripts/build-universal-windows.ps1` (§8).

Gotchas:

- A plain `cargo build` does **not** stage bundled resources the way Tauri's
  packaging does, so `lib` copies `resources/diarization` and `templates` next
  to the exe manually. Without this, `resource_dir()` finds nothing.
- The frontend is embedded at compile time. After changing frontend code you
  must rebuild the frontend *and* relink the exe.
- The exe cannot be relinked while it is running (LNK1104). Kill it first.
- Build with `--features cuda,custom-protocol`. Without `custom-protocol` the
  binary tries to load a dev server on localhost instead of the embedded UI.
- A Vulkan build needs a short cargo target dir (at most 31 characters with
  Ninja, 22 without): whisper.cpp 1.8 builds its Vulkan shader generator as a
  nested CMake project inside it, and the compiler cannot write past Windows'
  259-character path limit. See [docs/BUILDING.md](docs/BUILDING.md).

---

## 8. Windows installer and onboarding

Packaging verification must include `binaries/onnxruntime/onnxruntime.dll`,
`onnxruntime_providers_shared.dll`, and `onnxruntime-LICENSE.txt` and compare them
with the verified build stage. Do not publish an executable-only update when
introducing this runtime resource; use a newly built installer package.

Protocol releases one Windows file, `protocol-windows-x64-setup.exe` (#15):
Tauri's NSIS installer built from this template and these hooks. People run it
directly and get its own pages; the [in-app updater](#in-app-updates) runs the
same file with `/P /UPDATE`. A newer setup run over an existing install upgrades it in
place. The frameless bootstrapper, the NSIS overall-progress plugin and the
install page's percentage timer that upstream wrapped around the installer were
removed in #15. The timer ran on the UI thread and used the registers and the
stack that the install section shares, so it could corrupt them mid-install.

The template is Tauri's stock `installer.nsi` of the CLI in
`frontend/pnpm-lock.yaml` (2.12.4) with Protocol's changes marked
`; Protocol:` (#44): the uninstall key, the install folder, the branding text
and `data\` on the delete-data choice, all described below. Actually Free's dark
skin and its custom welcome, folder and finish pages are gone, and so are its
update-mode delay, settings broadcast and shortcut refresh. When the Tauri CLI
changes, start from the new version's stock file and apply the marked changes
again. `English.nsh` is the same CLI's English text with only the uninstaller's
delete-data checkbox reworded.

### Setup path

```text
release.yml (tag) -> release-build-windows.yml -> build-universal-windows.ps1
  -> Vulkan variant (cargo build --features vulkan) -> installer-variants\
  -> its bundle-type marker patched to nsis; probe built; runtime deps staged
  -> tauri build bundles the CPU build as protocol.exe (stock template + hooks)
  -> a person runs protocol-windows-x64-setup.exe: welcome, reinstall choice
     over an existing install, folder, install, finish (Tauri's stock pages);
     the updater runs it with /P /UPDATE: the install page only
  -> hooks: Visual C++ runtime, DirectML, Vulkan probe, Vulkan or CPU
```

Relevant files:

| File | Responsibility |
|---|---|
| `frontend/src-tauri/windows/installer.nsi` | Tauri's stock NSIS template (CLI 2.12.4) with the `; Protocol:` changes: the install/update engine and its pages |
| `frontend/src-tauri/windows/English.nsh` | Tauri's English installer text; only the delete-data checkbox differs |
| `frontend/src-tauri/windows/installer-hooks.nsh` | Dependency checks, runtime staging, Vulkan/CPU selection, the saved backend override, uninstalling what the hooks installed |
| `frontend/scripts/build-universal-windows.ps1` | Builds the Vulkan variant and the CPU bundle, writes the setup and its checksum |
| `frontend/scripts/stage-runtime-deps.ps1` | Stages DirectML and the pinned Visual C++ redistributable |
| `frontend/scripts/verify-windows-release.mjs` | Checks the setup's payload without installing it |

Fresh installs default to `%LOCALAPPDATA%\vmedvedevpro\Protocol`:
`bundle.publisher`, then the product name with spaces replaced by hyphens, so the
generic product name cannot collide with another app's folder and Labs bundles
(`Protocol Labs Local Test`) get their own space-free `Protocol-Labs-Local-Test`
folder instead of sharing executables and `data` with the main install. Setup
restores a previously registered install path from
`HKCU\Software\vmedvedevpro\Protocol` (NSIS `${MANUPRODUCTKEY}`:
`bundle.publisher` and `productName` from `tauri.conf.json`), so an existing
install is upgraded in its own folder. The uninstall entry is keyed by the
bundle identifier (`HKCU\…\Uninstall\io.github.vmedvedevpro.protocol`), not the
product name. These values must stay distinct from upstream Meetily builds,
otherwise setup offers, and overwrites, their folder. Both the key name and the
default folder are `; Protocol:` changes to the stock template, which would use
`…\Uninstall\Protocol` and `%LOCALAPPDATA%\Protocol`; installs since 0.3.0 are
registered under these.

The app keeps its data in `data\` inside the install folder (`paths.rs`): the
meeting database, downloaded models, voice profiles, settings and crash
reports. Uninstalling leaves it, and with it the install folder, unless the
uninstaller's box "Delete transcripts, summaries, voice profiles, models and
settings" is ticked. Then it also deletes `data\`, Tauri's
`%APPDATA%\io.github.vmedvedevpro.protocol` and
`%LOCALAPPDATA%\io.github.vmedvedevpro.protocol` (plugin stores, WebView
profile, update cache) and `HKCU\Software\vmedvedevpro\Protocol`. Recordings
live in the recordings folder (`Music\protocol-recordings` by default) and are
never deleted. The uninstaller deletes only the files the bundle lists, so the
uninstall hook deletes what the install hook added (`DirectML.dll`, and the
CUDA DLLs of a pre-0.3.0 install), then the install folder and the publisher
folder, each only once it is empty.

Backend selection belongs to `installer-hooks.nsh`. The package bundles the CPU
build as `protocol.exe` and stages only `protocol-vulkan.exe` and the probe; the
hook replaces `protocol.exe` with the Vulkan build when the probe succeeds and
otherwise keeps the CPU build. The
executable no longer shares upstream's `meetily.exe` name (#12), so setup and
uninstall leave a running Meetily or Meetily – Actually Free alone, except
during the one-time upgrade from a pre-#12 install described below. The
uninstall hook stops only the process whose image path is this install's
`protocol.exe` (a Toolhelp snapshot plus `QueryFullProcessImageNameW`, not
`taskkill /IM`), and it does so without asking. Tauri's running-app check
(`CheckIfAppIsRunning` in `installer.nsi`, before install and uninstall) is
path-based as well since tauri-bundler 2.10 (#33): it registers
`$INSTDIR\protocol.exe` with Windows Restart Manager and shuts down only the
processes using that file, so a Protocol dev build or a Labs install elsewhere
keeps running. Before install it asks in an interactive run and closes the app
without asking in passive (`/P`, how the updater runs setup) and silent
runs. Uninstall runs the hook before the check, so the check normally
finds nothing there: even an interactive uninstall terminates a running
Protocol at once, with no prompt and no end-session request, and a recording in
progress ends as it would in a crash. The template must pass the full path and
include `Win\RestartManager.nsh`, which the bundler's `utils.nsh` needs. Setup
also leaves a build running from another folder under the same identifier (a
dev build or a local build from before #33), and if that build has
`tauri-plugin-single-instance` 2.3.7 the new build cannot reach it: 2.5.4
forwards the launch in a message 2.3.7 ignores and then exits, so nothing
opens; close such a build first. One exception applies on the first upgrade over an install
that already has `protocol.exe` but was built before #33: when setup runs that
install's old uninstaller (the default choice of an interactive upgrade or
downgrade, and a passive run over the same version), its check, built with
CLI 2.11, still matches `protocol.exe` by name, so it also finds a dev build or
a Labs install elsewhere, asking first in an interactive run and closing it
without asking in a passive one.

The first setup over a pre-#12 install, one that still has `meetily.exe`, is a
one-time transition that the installer does not special-case:

- Setup runs the old install's own uninstaller after the default choice of an
  interactive upgrade or downgrade ("Uninstall before installing") and in a
  passive run over the same version. That old uninstaller still runs `taskkill /IM meetily.exe /F` and
  `CheckIfAppIsRunning "meetily.exe"`, so it force-stops every `meetily.exe` of
  the user, including a separately installed Meetily or Meetily – Actually
  Free. Close Meetily too before this upgrade. The check that setup runs after
  the old uninstaller looks for `protocol.exe`, so it misses a `meetily.exe`
  that uninstaller left behind.
- When no uninstall step runs (for example a passive run over another version,
  or an interactive run without the uninstall choice), nothing closes the old
  install's running `meetily.exe`, because the hook and the check look only for
  `protocol.exe`. The template's `MainBinaryName` cleanup then cannot delete
  the locked `meetily.exe`, does not report it, and records `protocol.exe`, so
  no later setup or uninstaller removes the leftover file. Close the old
  Protocol before upgrading and delete a leftover `meetily.exe` from the
  install folder by hand.
- If an interactive run without an uninstall step ends with the
  desktop-shortcut box unticked, an existing desktop `Protocol.lnk` keeps
  pointing at `meetily.exe`. The uninstaller removes only shortcuts that target
  `protocol.exe`, so delete that one by hand.

There is no CUDA build. An explicit `/BACKEND=vulkan|cpu` (for example
`protocol-windows-x64-setup.exe /BACKEND=cpu` from a terminal) is saved as
`BackendOverride` under `HKCU\Software\vmedvedevpro\Protocol` and reused by
every later install and update that has no `/BACKEND`; `/BACKEND=auto` clears it,
and an uninstall that deletes app data removes it with the key. Without the saved
choice, an update would run the probe again and reselect a Vulkan build that the
user left because its driver crashed in inference, which the probe cannot detect.
The selected Whisper backend is compiled into the installed executable, so a GPU
or driver change after install takes effect at the next install or update. The
launch-time CUDA check (`get_cuda_reconfiguration_status`,
`CudaReconfigurationNotice.tsx`, Setup Overview) reports "not applicable" unless
the app is built with `--features cuda`. Installs over a pre-0.3.0 build delete
the CUDA DLLs it had copied next to `protocol.exe`. In update mode a failed or
missing Visual C++ setup only warns: the files are already replaced, and aborting
would leave a half-updated install behind the updater's passive window.

Vulkan selection requires the 64-bit system loader and runs the staged x64
`protocol-vulkan-probe.exe`, which selects the devices Whisper can run on (the
discrete GPUs, else the first device) and
requires every selected device to provide Vulkan 1.2, a compute queue, 16-bit
storage support, and successful logical-device creation. That was GGML's own
policy in whisper.cpp 1.7.1; 1.8 also registers integrated GPUs, so
`whisper_engine/acceleration.rs` passes whisper.cpp the first discrete GPU as
`gpu_device` to keep the two in step. This follows modern
Intel/AMD DCH discovery without a fragile registry scan. Do not
replace it with a loader-file-only check: stale loaders can exist without a
usable ICD, and the Vulkan backend cannot safely assume CPU fallback. A legacy
Khronos ICD scan remains only for packages missing the probe. The helper is
installer-only and is removed with the staged variants after selection.

The in-app updater runs the installer with `/P /UPDATE` (passive, update mode),
plus `/R` after **Restart and update** so it starts the new version; after a
quit it starts nothing. Passive mode skips every page except Tauri's stock
install page, which shows NSIS's progress bar and closes itself when done. In
update mode the stock template keeps the existing Start menu and desktop
shortcuts as they are and skips the WebView2 setup; all hardware/runtime
decisions in the hooks are the same as in a normal install. Do not add timers
(`nsDialogs::CreateTimer`) to the install page, since their callbacks share
`$0`–`$R9` and the stack with the running section.
Every install/update rewrites uninstall-key `DisplayVersion`. The stock template
sends no settings-change notification, so an Installed apps page left open
during an update can keep showing the previous version until it is reopened.

### In-app updates

`frontend/src-tauri/src/updater/` owns checks, downloads and installs through
`tauri-plugin-updater` 2.14; the feature note is
[docs/AUTO_UPDATE.md](docs/AUTO_UPDATE.md).

- **Feed.** `plugins.updater.endpoints` is the Latest release's
  `latest.json`; `requireSignedVersion: true` binds each minisign signature to
  the version it names, and the public key is `plugins.updater.pubkey`.
  Windows reads `windows-x86_64-nsis` (then `windows-x86_64`), both pointing at
  `protocol-windows-x64-setup.exe`; macOS `darwin-aarch64-app`; Linux
  `linux-x86_64-appimage`. Builds without a Tauri bundle-type marker (dev,
  portable copies) never check; `.deb` installs check and link to GitHub.
- **When.** The scheduler task starts with the app, ticks every 10 minutes
  (first after 2), and checks once 24 hours have passed since the last
  completed check, with 1/2/4/6 h backoff after failed automatic checks (a
  failed manual check does not count). It waits for onboarding and honours the
  Settings › About switch. A manual check always runs.
- **Download.** Only on the user's click. It does not start, and is cancelled,
  while a recording runs; it resumes on its own afterwards. The verified payload
  and its feed entry are cached in `app_cache_dir()/updates`, so a restart
  offers **Restart and update** again without a new download.
- **Install.** `updater::install` takes the engine lifecycle lock (no recording
  or batch transcription can start), re-checks `updater::busy`, checkpoints the
  WAL, stops llama-helper, closes the crash session, writes an install marker,
  and hands the payload to the plugin. On Windows the plugin starts the NSIS
  installer and exits the process itself, so `RunEvent::Exit` does not run;
  macOS and Linux replace the bundle in place and then restart or exit. Tray
  Quit (and ⌘Q / Dock Quit on macOS) installs a downloaded update without a
  relaunch when nothing is busy. During a recording it first asks to stop and
  save it and waits for the meeting to be saved (`quit.rs`, #32).

### Onboarding

Onboarding is rendered by
`frontend/src/components/onboarding/OnboardingFlow.tsx`. It asks nothing about
updates; `steps/SetupOverviewStep.tsx` only says that Protocol checks GitHub
once a day and downloads an update only on a click, and the updater makes no
request before onboarding completes. An older `data/check-updates-on-launch.txt`
left by upstream builds is ignored. The fork's issues link is in `steps/SetupOverviewStep.tsx`
and uses the `open_external_url` Tauri command because browser-style
`target="_blank"` links are unreliable inside a desktop webview. On Windows that
command calls `ShellExecuteW` directly; do not regress it to `cmd /C start`,
which flashes a console and mishandles some URLs.

The main window has `center: true` in `tauri.conf.json` so first-run onboarding
opens on the center of the active display instead of inheriting Windows' default
top-left placement.

Model downloads are sequential: the required Parakeet transcription model owns
the connection until it reaches 100%, then the selected summary model starts.
The download step labels these as Step 1 and Step 2 and renders only the active
step's progress bar. After the user continues, active transfers appear as a
compact top-right indicator that expands on hover or keyboard focus; it must not
reserve space or shift later onboarding pages. Completion and errors use short
bottom-right Sonner notifications.

Built-in summary models use the exact byte size of the version on record (its
install record, or the 0.3.0 pin). Smaller files are
`Incomplete`, retained, and resumed with a validated HTTP `Content-Range`; only
an exact-size file with valid GGUF magic becomes `Available`. Progress reaching
100 is not completion until validation succeeds and Rust emits `completed`.

### Release rules

- Releases are built by `.github/workflows/release.yml` from a pushed tag
  (`WORKFLOWS_OVERVIEW.md`); a local build is for testing only.
- Builds are unsigned unless `DIGICERT_KEYPAIR_ALIAS` configures Authenticode;
  an unsigned build must pass the explicit `-AllowUnsigned` switch.
- When PDBs are generated, the builder keeps each EXE/PDB pair in
  `target/release-symbols/<version>/{vulkan,cpu}` before the next build in the
  same target dir overwrites it.
- `SHA256SUMS.txt` covers the setup; the release adds every other asset.
- The Vulkan executable is copied out of `target\release` before `tauri build`
  relinks it as the CPU build, and patched with the `nsis` bundle-type marker
  before it is signed; the updater (#31) reads that marker.
- `tauri.universal.conf.json` deliberately clears `beforeBuildCommand`. The
  script builds Next.js once unless `-SkipFrontend` is passed; letting Tauri build
  it again changes the embedded assets and forces a redundant relink. The script
  creates `universal.marker` only around the bundling step; a standard Tauri
  bundle without it keeps its compiled executable.
- `node frontend/scripts/verify-windows-release.mjs [asset-directory]` verifies
  the checksum, NSIS archive integrity, the packaged variant and runtime sets, the
  Vulkan import of each executable and their bundle-type markers without
  installation.
- Isolated worktrees can pass `-LlvmDir` and `-VulkanSdk` to reuse installed
  toolchains, and `-OutputDir` to keep the result out of `dist`.

### Branding assets

The Protocol mark is a recording dot that turns into lines of a transcript:
ink `#15171C` rounded square, recording accent `#FF5A36`, lines `#F3F2EE`.
`frontend/src-tauri/icon-source.svg` is the canonical vector;
`icon-source.png` (and its copy `icon-1024.png`) is its 1024×1024 render.
`icon-source-small.svg` is a simplified two-line variant drawn for 16–32 px,
where three thin lines blur together in the tray and title bar.

Regenerate the set after changing either SVG:

1. Render `icon-source.svg` to a 1024×1024 PNG (`icon-source.png`) and
   `icon-source-small.svg` to 16, 20, 24 and 32 px PNGs (any SVG renderer;
   headless Chromium matches the browser exactly).
2. From `frontend/`, run `pnpm tauri icon src-tauri/icon-source.png`. It writes
   the desktop family plus `android/` and `ios/`; delete those two folders —
   Protocol ships no mobile build.
3. Replace `icons/32x32.png` with the 32 px small render, and rebuild
   `icons/icon.ico` with frames 16/20/24/32 from the small renders and
   48/64/128/256 from the master, so the tray and taskbar get the legible
   variant.
4. Downscale the master into `public/logo.png` (512), `logo-collapsed.png`
   (256), `icon_128x128.png` and `icon_32x32@2x.png` (64), and build
   `src/app/favicon.ico` (16/32 small, 48 master).

The generated files feed every native surface through these connections:

```text
icon-source.svg -> icon-source.png (+ icon-source-small.svg for 16-32 px)
  -> icons/icon.ico  -> Windows app/taskbar + NSIS installer
  -> icons/icon.png  -> native Windows notifications
  -> default app icon -> system tray (tray.rs)
  -> icons/icon.icns -> macOS bundle
  -> public/logo-collapsed.png + public/icon_*.png -> in-app/web assets
  -> src/app/favicon.ico -> Next.js favicon
```

`tauri.conf.json` (app and `bundle.windows.nsis.installerIcon`) references the
generated `icon.*` family. Do not introduce a second `app_icon.*` family: that
previous duplication allowed the tray/app and installer to silently use
different brands.

On Windows, `io.github.vmedvedevpro.protocol` is also the single shell identity:
it is Tauri's bundle identifier, the installer shortcut AUMID, and the explicit
process AUMID (`notifications/native_windows.rs`) set before any windows are
created. Changing it detaches the app from upstream Meetily's single-instance
lock, WebView storage, and plugin stores. Setup creates the Start menu
shortcut, and the desktop shortcut when its finish-page box stays ticked
(always in a silent or passive first install), with that AUMID, as Tauri's
stock template does; updates leave existing shortcuts alone. Application
startup must not replace those installer-owned shortcuts with PNG-backed
WScript shortcuts.

---

## 9. macOS Apple Silicon capture and releases

The supported macOS target is Apple Silicon on macOS 14.2 Sonoma or later. The
minimum is not merely a product choice: the native Core Audio process-tap path
depends on APIs introduced in 14.2. Keep these declarations aligned:

| Declaration | Responsibility |
|---|---|
| `frontend/src-tauri/.cargo/config.toml` | Rust linker deployment target |
| `frontend/src-tauri/tauri.macos.conf.json` | Tauri bundle minimum system version |
| `.github/workflows/release-build-macos.yml` | CI `MACOSX_DEPLOYMENT_TARGET` |
| `README.md` | User-visible support statement |

### Native capture and permission model

Responsibility map:

| File | macOS responsibility |
|---|---|
| `audio/capture/core_audio.rs` | Create the global process tap, aggregate device, stream, and audible probe |
| `audio/permissions.rs` | Keep the legacy `screen_recording` function names while routing verification to the Core Audio probe |
| `audio/capture/backend_config.rs` | Accept only the backends implemented on the current platform |
| `components/onboarding/steps/AudioTestStep.tsx` | Serialize the native singleton monitor and guide audible testing |
| `hooks/usePermissionCheck.ts` | Session-scoped verification state and deduplicated manual Recheck |
| `audio/recording_preferences.rs` | Custom-root safety and applying the saved backend preference |
| `.github/workflows/release-build-macos.yml` | Build, verify and launch the DMG and updater bundle of a release; never publishes |
| `.github/workflows/release-published.yml` | Check the published release's assets, checksums, feed and signatures |

macOS uses one implemented system-audio backend: the Core Audio global process
tap in `audio/capture/core_audio.rs`. `AudioCaptureBackend::from_string()`
therefore accepts only Core Audio on macOS, and no command offers the UI a
backend choice. The `ScreenCaptureKit` enum variant
still exists for cross-platform compatibility and old settings, but it must not
be offered as a selectable macOS backend.

The global tap follows the current default output route. A listed output-device
name proves that an output exists; it does not prove Audio Capture authorization,
and a non-default output name cannot retarget the global tap. The macOS UI keeps
this route read-only and directs users to Sound settings. Do not restore a
selectable output list unless capture actually binds to that route.

Creating the process tap triggers the OS Audio Capture prompt. A successful tap
creation is still not enough because a denied tap can produce an all-zero stream.
`trigger_system_audio_permission_command` starts the real tap for up to five
seconds and returns early only after receiving an audible sample. UI text must
ask the user to play audio during that interval. The result is stored in
`sessionStorage`, not durable app storage: authorization can be revoked between
launches, so each new app session must not trust an old success forever.

`AudioTestStep` serializes transitions because `start_audio_level_monitoring`
controls one process-global native monitor. Retests, device changes, React
StrictMode cleanup, and unmount can overlap asynchronous permission calls. Keep
the generation checks after every await and keep the transition chain; a stale
probe must not start or stop the next probe's monitor.

Core Audio can change sample rate when the default route changes. The live
resampler is configured at stream creation and cannot safely absorb that change,
so the stream reports a fatal error and uses the command-owned stop/final-save
path. Unexpected stream completion does the same. Never reduce either condition
to a log line while the global recording flag remains true.

Recording destination initialization is also part of startup, not a best-effort
background operation. The custom root is created and write-probed before it is
persisted; `RecordingSaver` creates its meeting folder/checkpoint savers before
returning a chunk sender. Otherwise the channel accepts and silently discards
all audio while the UI appears to record.

The two required privacy strings are `NSMicrophoneUsageDescription` and
`NSAudioCaptureUsageDescription` in `Info.plist`. The shipped entitlement file
contains only the audio-input entitlement currently needed by this build. Do not
add speculative screen-capture, audio-output, or temporary-exception keys; CI
parses both files and verifies the packaged values.

### Bundle integrity and writable data

A signed `.app` is immutable at runtime. Writing a database, settings, models,
or logs beneath `Protocol.app/Contents/MacOS` changes the sealed bundle and makes
`codesign --verify --deep --strict` fail after first launch. macOS therefore
uses `~/Library/Application Support/vmedvedevpro/Protocol` for core data,
`~/Library/Application Support/io.github.vmedvedevpro.protocol` for Tauri plugin stores, and
`~/Movies/protocol-recordings` (or the configured root) for recordings. Bundled
diarization models and sidecars are read-only resources.

The macOS release leg (`release-build-macos.yml`) deliberately launches the installed
app twice and verifies its signature after runtime writes. The first launch covers
fresh database/onboarding initialization; the second covers reopening existing
state. Keep both launches and the post-launch signature checks. A build-only
signature check cannot detect this class of regression.

### Release topology

macOS is one leg of the common release (`release.yml`, #15): the same tag and
draft release carry `protocol-macos-arm64.dmg` for people and
`protocol-macos-arm64.app.tar.gz` (+ `.sig`) for the updater. Upstream's separate
`vX.Y.Z-macos` publication (`build-macos.yml`, `publish-macos.yml`,
`smoke-test-macos-release.yml`, `MACOS_RELEASE.md`) was removed.

- `.github/workflows/release-build-macos.yml` builds `--bundles app,dmg`, runs the
  native tests, executes both sidecars, validates architecture, metadata,
  resources and entitlements, installs the app, launches it twice, and uploads the
  DMG and the updater bundle. It never publishes.
- The updater signature is made in the release's `draft` job over the final
  bytes; the leg signs with a throwaway key only because `tauri build` requires a
  key once updater artifacts are on (`--no-sign` would also drop the ad-hoc
  signature).

Unsigned CI builds are ad-hoc signed and are not notarized. First launch may
require Control-click and Open. Notarization is enabled only when all Apple
certificate/account secrets are configured and `sign-and-notarize=true`; never
claim notarization based on ad-hoc `codesign` success. The release workflow has
no notarization step; it would need Apple secrets that this repository does not
have.

CI runs on an explicit Apple Silicon macOS 15 image while retaining and checking
the 14.2 deployment target. The runner has no meaningful microphone, speaker
route, Bluetooth device, or
interactive privacy UI. Native CI proves build, package, sidecar, startup,
storage, and signature invariants, but a physical Apple Silicon Mac must still
test on macOS 14.2: microphone input, audible system capture, permission
denial/retry, output-route changes, pause/resume/stop, and the three retained MP4
tracks. The release workflow cannot do that; test on a Mac before publishing a
release that changes macOS capture.

The release procedure is in `.github/workflows/WORKFLOWS_OVERVIEW.md`.
