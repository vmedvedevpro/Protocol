# The app's log and Save logs (#234)

Protocol writes its log to files, so a tester on hardware the owner lacks can
send it with a bug report: Settings › Advanced › Bug reports › **Save logs**
puts it into one ZIP.

## Where the lines go

`main.rs` exits first for the CLI modes, then calls `app_log::init()` before
anything else, Tauri included: the `log` crate takes one global logger, and a
logger set up in Tauri's `.setup` would miss the data-root resolution, the
panic hook and plugin start.

| Source | How it reaches the log |
| --- | --- |
| Native code | the `log` macros, unchanged |
| whisper.cpp and ggml (model load, devices, backends) | whisper-rs's `log_backend` feature; `init` calls `whisper_rs::install_logging_hooks()` |
| Panics | `crash_report.rs`'s hook calls `app_log::record_panic`: thread, `file:line:column` and the message (cut at 500 characters), beside the crash report's own record |
| The WebView | `log_webview_error` (`src/api/logs.ts`): `main.tsx` sends uncaught errors and unhandled rejections; `RouteError`, the route table's `errorElement` (in the shell, so the title bar stays, and around the shell), sends what a screen threw and shows "Something went wrong" with Reload and Back to meetings; the minibar's `MinibarError` shows one line and Reload in its pill |

The WebView's errors are filtered twice. `logWebViewError` drops
Chromium's "ResizeObserver loop" note (nothing failed; the layout settles a
frame later) and a repeat of the same kind, message and stack within 5 s,
since a render loop or a timer repeats one error many times a second. It
remembers at most 100 errors and forgets them all past that, so an error
whose text changes every time does not grow the map for the page's life.
Native `log_webview_error` then logs at most 30 a minute
(`WEBVIEW_ERRORS_PER_MINUTE`; one failing screen logs a few, and more would
push earlier launches out of the kept files). The first error past that is
dropped with one warning that further WebView errors are not logged until
the minute ends, so a burst that then stops is still seen.

The logger is [flexi_logger](https://docs.rs/flexi_logger/0.31.10) 0.31.10
(`app_log/mod.rs`), pinned: 0.32.0 was a week old when this was written.
Files are written from its own thread (`WriteMode::AsyncWith`, an unbounded
channel), so a log call on a capture or inference thread never waits for the
disk, and each line is copied to stderr for a run from a terminal. The
level is `info`; ONNX Runtime's `ort::logging`, `zbus` and `tracing::span`
log only warnings and errors, since their info lines are bookkeeping (about a
thousand ORT arena and session lines for one import, D-Bus handshakes as byte
lists).

A line reads `2026-11-26T09:30:00.123+03:00 INFO  target: message`, in local
time so a tester's "it broke at half past nine" finds it. As each line is
formatted, `scrub::secrets` masks provider keys (`sk-`, `sk_`, `gsk_`),
bearer tokens, `key=value` and `key: Some("…")` secrets, a bare `?key=` query
parameter and a URL's `user:password@`. A digits-only value is masked too (a
numeric password or PIN), except after a bare `token`, so llama.cpp's
`BOS token = 1` stays. The patterns are a
second line behind the audit below: a pattern cannot tell a transcript from
any other text.

## Files

`<install data root>/logs` (`paths.rs`), beside `crash-reports/`:

- Windows: `<install folder>\data\logs`, or the OS data folder
  (`%APPDATA%\vmedvedevpro\Protocol\logs`) when the install folder is not
  writable.
- Linux: `<executable folder>/data/logs`, else
  `~/.local/share/vmedvedevpro/Protocol/logs` (an AppImage's or a deb's
  executable folder is read-only, so installs use the latter).
- macOS: `~/Library/Application Support/vmedvedevpro/Protocol/logs`.

Files are named after their start, `protocol_r2026-11-26_09-30-00.log`. A
launch continues the newest file (`append`): without it, a launch opens a file
named after the current second and truncates it, so a second instance started
in the same second (a double click) would cut the running one's log. A new
file starts past 2 MiB (`FILE_CAP`: easy to open in an editor, and the cleanup
removes history in steps no larger than that), and the 10 newest are kept
(`FILES_KEPT`, the current one included). The folder thus holds at most
20 MiB, which deflates to a ZIP of a few MiB, under GitHub's 25 MB attachment
limit. A launch loses its first lines only when the launches after it write
more than that. Each launch starts with a `Protocol <version> on <os> <arch>,
process <pid>, data root <path> (<how it was chosen>), log folder …` line. The
process id tells two instances apart, since a second launch writes into the
running one's file; the data root is resolved before the logger starts, so
`paths::data_root_origin()` keeps how it was chosen (portable, or the OS
data folder and why) for this line.

The process ends without dropping the static logger, so the last lines are
written by `app_log::shutdown()`: on `RunEvent::Exit`; in the updater's
`on_before_exit` (`updater/engine.rs`), since the Windows install ends in
`process::exit` past `RunEvent::Exit` (the hook replaces the plugin's own,
so it also calls `cleanup_before_exit`); before the `abort()` in
`whisper_engine/vulkan.rs`; and in the panic hook when the main thread
panics. A panic on another thread only asks for a flush (`flush()` does not
wait), since the app runs on and a stopped writer would lose the rest of its
log. A process killed outright loses at most the last 200 ms of lines
(`FLUSH_INTERVAL`; flexi_logger's default second lost the lines just before a
crash, and 200 ms costs at most five small writes a second).

## When the log cannot be written

flexi_logger opens its file only at the first line, so its `start` succeeds
in a folder it cannot write. `init` therefore probes the folder first: it
creates it and writes into an unnamed temporary file there (`probe`). If that
fails (a root-owned `logs/`, a full disk), it falls back to stderr alone and
keeps the reason.

flexi_logger reports later write and rotation failures only through its
error channel, which can be stderr, stdout, nothing, or a file. The file is
the one way the app can read them back, so it stays:
`<OS cache folder>/io.github.vmedvedevpro.protocol/log-errors/protocol-log-errors-<pid>.txt`
(`errors_file()`; the data root's `cache` when the OS has none), the folder
Tauri's `app_cache_dir` names, which `init` cannot ask for since it runs
before Tauri. It is outside the log folder, which is the one failing, and
not in the shared temporary folder, where another user could plant a link at
its predictable name. It is per process, so a second launch does not read
the first's, and `init` deletes a file left with its own id, since Windows
reuses process ids. flexi_logger never panics over it
(`panic_if_error_channel_is_broken(false)`). `get_log_status` returns the
start reason or the last error in that file, and the Bug reports row shows it
in place of its description. Save logs still saves what is there, with the
error file as `logs/log-errors.txt`.

## What the log leaves out

Its lines are written to leave out transcript text, summaries, notes,
prompts, model replies, speaker names, API keys and tokens. The audit for
#234 changed the lines that printed them, among them every live chunk's text
at the info level (`audio/transcription/worker.rs`), the first transcript
segment as JSON and parsed (`api/api.rs`), a custom endpoint's whole reply,
and the speaker names of a rename and a cluster match (`diarization/mod.rs`);
they now log a count. In particular:

- A summary provider's error reply can quote the prompt. `llm_client.rs`
  logs its status and byte count, and the error it returns carries the reply
  after `PROVIDER_REPLY`, so the UI still shows it; `llm_client::loggable`
  cuts it off where `processor.rs` and `service.rs` log the error.
- serde errors quote the value they could not read, which can be a stored
  summary or transcript; `app_log::json_error` logs their kind and place.
- Endpoint addresses go through `scrub::address`, which drops the
  `user:password@`, query and fragment.

Meeting titles, file and folder names, audio device and model names, service
addresses and error messages stay where a bug needs them, and the ZIP's
README says so. It does not promise more than the code keeps: an error
message from a library can still quote what it was given.

`scripts/log-audit/check-log-lines.mjs` keeps it so. It reads every call of
the log macros (`log`'s, `log_info!` and its siblings, `perf_debug!`,
`perf_trace!`, `audio/async_logger.rs`'s `async_info!`, `async_warn!` and
`async_debug!`, `log::log!`) and of `eprintln!`, `println!` and `dbg!` in
`frontend/src-tauri/src`, over several lines too, outside `#[cfg(test)]`
modules (their output goes to the test runner). It fails on a value whose
name ends in a word for content or a secret (`text`, `transcript`,
`summary`, `notes`, `prompt`, `response`, `body`, `message`, `msg`, `output`,
`preview`, `token`, `api_key`, …), and on a name bound earlier in the file
with `let x = format!(…)` from such a value. A value reduced to a length,
count, status or a path's `display()` passes (`text.chars().count()`,
`response.status()`); a reviewed line carries `// log-audit: <reason>`.
Values are judged by name, and a `format!` binding taints its name in the
whole file, not its scope. A struct printed with `{:?}` under a neutral name
gets past it: review those by hand. PR checks run it with its tests
(`scripts/log-audit/test/`).

The summary sidecar's stderr (`llama-helper`) is inherited, not logged: it
reaches a terminal only, and never the files.

## The ZIP

`save_logs_zip` (`app_log/bundle.rs`) first waits for the queued lines:
flexi_logger's flush does not wait, so `flush_and_wait` logs a line of its
own, flushes, and waits up to 2 s for that line in the newest file, since
the writer takes lines in order. The line names the process and the save
(`Saving the logs (process 4242, save 1)`): every launch appends to the same
newest file and counts its saves from 1, so a save number alone would find
an earlier launch's line and not wait. It then writes, through a temporary
file beside the destination (`zip_util::write_zip`, which the crash report's
ZIP uses too, and `zip_util::is_zip`, the one `.zip` check):

| Entry | Content |
| --- | --- |
| `README.txt` | what is included and not, and that titles and device names may appear |
| `system.txt` | version, OS, architecture, acceleration backend, rounded cores and memory (`crash_report::system_summary`, the crash report's facts) |
| `logs/protocol_r….log` | every kept log file |
| `logs/log-errors.txt` | the errors flexi_logger had writing the log in this run, if any |
| `updater/updater.log`, `updater/updater.log.old` | the updater's journal, from `updater::journal_dir` |
| `crash-report.json` | the pending crash report, if there is one |
| `speech-check.txt` | the last Speech check's report while Settings › Advanced shows it, finished or interrupted (`speech_check::latest_report`, scrubbed by the check and again here); none once dismissed, or after a restart following a check that finished |
| `unreadable.txt` | the files that could not be read and why, if any: one unreadable file does not fail the save |

Every entry passes through `scrub::Identity`. The home folder becomes `~`:
one pattern, in any case (Windows paths), each separator as `\`, `/` or
JSON's `\\`, the last folder also as its 8.3 short name (`ANNALE~1`) on
Windows and a space also as `%20`, up to a word boundary. The user name
becomes `<user>`: whole words, two letters or more, `%20` for a space, and
not a login that is an ordinary word (`root`, `user`, `admin`,
`administrator`, `guest`). The save
dialog is the crash report's (`src/api/saveDialog.ts`, with its GTK `.zip`
re-ask); the default name is `Protocol-logs-<local date>.zip`. After saving,
the group names the file and offers **Show in folder**: Explorer and Finder
select it (`explorer /select,`, `open -R`), Linux opens its folder with
`xdg-open` (`paths::open_in_system`, which also opens the meeting and
recordings folders and, outside Windows, a link).

## CLI modes

They keep their own logging and never write to the app's log: the macOS
audio-permission probe and the Linux MCP pass-through (`--mcp-server`) exit in
`main` before `init`; `measure` and the hardware qualification are `cargo test`
code that never runs `main` and starts `env_logger` itself.

## Tests

- `cargo test -p protocol --lib -- app_log llm_client`: rotation and the
  count limit at a small cap, a launch continuing the newest file, secret
  masking in a written line (digits-only values but a token id), the probe
  of an unwritable folder, the WebView error limit and its one warning, a
  save's wait past an earlier launch's marker, the error file's place and
  its last line for Settings, JSON errors without their value, addresses without
  credentials, scrubbing (Linux and Windows homes in every spelling,
  whole-word user names, common logins), the ZIP's entries, an unreadable
  file, missing folders, the `.zip`-only destination, and a logged summary
  error stopping before the provider's reply.
- `cargo test -p protocol --test app_log_panic`: a panic's thread, place and
  message reach the file (its own binary, for the global logger).
- `cargo test -p protocol --test app_log_save`: `flush_and_wait` against a
  temporary folder whose newest file already holds an earlier launch's save
  marker ends on this launch's own marker, well before its timeout, with
  the lines logged before it in the file. The writer thread is rarely slow
  enough for a skipped wait to show there; the unit test above is what fails
  if an earlier launch's marker ends the wait.
- `node --test "scripts/log-audit/test/*.test.mjs"` and
  `node scripts/log-audit/check-log-lines.mjs`.
- Frontend: `LogsGroup.test.tsx` (save, cancel, the failure state, the file
  name), `RouteError.test.tsx` (the alert and its focus, the minibar's
  error), `src/api/logs.test.ts` (window errors, the repeat and
  ResizeObserver filter, forgetting past 100 errors); stories `Shell/RouteError` (Light, Dark, Minibar).

## Limits

- Windows and macOS are proven only by compile checks in the release dry run:
  the folder on each, Explorer's and Finder's selection, and a GUI-subsystem
  Windows build's stderr (Rust treats the missing handle as a sink).
- A struct printed under a neutral name is outside the checker's reach.
- The panic message is the panic's own text; an `expect` on an error that
  carries content would print it (cut at 500 characters).
- A write failure that also fails to reach the error file (the cache folder
  full or unwritable too, as on a full disk it shares with the log folder)
  is reported nowhere but stderr.
- Error files of earlier processes with other ids stay in the cache folder;
  flexi_logger creates one only on an error.
