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
| The WebView | `log_webview_error` (`src/api/logs.ts`): `main.tsx` sends uncaught errors and unhandled rejections; `RouteError`, the route table's `errorElement` (in the shell, so the title bar stays, around the shell, and on the minibar), sends what a screen threw and shows "Something went wrong" with Reload and Back to meetings |

The logger is [flexi_logger](https://docs.rs/flexi_logger/0.31.10) 0.31.10
(`app_log/mod.rs`): files written from its own thread (`WriteMode::Async`, an
unbounded channel), so a log call on a capture or inference thread never waits
for the disk, and each line copied to stderr for a run from a terminal. The
level is `info`; ONNX Runtime's `ort::logging`, `zbus` and `tracing::span`
log only warnings and errors, since their info lines are bookkeeping (about a
thousand ORT arena and session lines for one import, D-Bus handshakes as byte
lists).

A line reads `2026-11-26T09:30:00.123+03:00 INFO  target: message`, in local
time so a tester's "it broke at half past nine" finds it. API keys, bearer
tokens and `key=value` secrets are masked as each line is formatted
(`app_log/scrub.rs`, `secrets`).

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
log folder …` line.

The process ends without dropping the static logger, so the last lines are
written by `app_log::shutdown()`: on `RunEvent::Exit`, and in the panic hook
when the main thread panics. A panic on another thread only asks for a flush
(`flush()` does not wait), since the app runs on and a stopped writer would
lose the rest of its log. A process killed outright loses at most the last
second of lines (the writer's flush interval).

## When the log cannot be written

If the folder or the file cannot be created, `init` falls back to stderr
alone and keeps the reason. flexi_logger reports later write and rotation
failures through its error channel, `logs/log-errors.txt` (cleared at each
launch; flexi_logger never panics over it, `panic_if_error_channel_is_broken
(false)`). `get_log_status` returns either reason, and the Bug reports row
shows it in place of its description. Save logs still saves what is there.

## What a log never holds

Transcript text, summaries, notes, prompts, model replies, API keys and
tokens. The audit for #234 changed 16 lines that printed them, among them
every live chunk's text at the info level (`audio/transcription/worker.rs`),
the first parsed segment (`api/api.rs`) and a custom endpoint's whole reply;
they now log a character or byte count. Two ffmpeg diagnostics are marked as
reviewed. Meeting titles, audio device names, model names and paths stay
where a bug needs them, and the ZIP's README says so.

`scripts/log-audit/check-log-lines.mjs` keeps it so: it reads every log macro
call in `frontend/src-tauri/src` (several lines too) and fails on a value whose
name ends in a word for content or a secret (`text`, `transcript`, `summary`,
`notes`, `prompt`, `response`, `body`, `token`, `api_key`, …). A value reduced
to a length, count or status passes (`text.chars().count()`,
`response.status()`); a reviewed line carries `// log-audit: <reason>`. Values
are judged by name, so a struct printed with `{:?}` under a neutral name gets
past it: review those by hand. PR checks run it with its tests
(`scripts/log-audit/test/`).

The summary sidecar's stderr (`llama-helper`) is inherited, not logged: it
reaches a terminal only, and never the files.

## The ZIP

`save_logs_zip` (`app_log/bundle.rs`) writes, through a temporary file beside
the destination:

| Entry | Content |
| --- | --- |
| `README.txt` | what is included and not, and that titles and device names may appear |
| `system.txt` | version, OS, architecture, acceleration backend, rounded cores and memory (`crash_report::system_summary`, the crash report's facts) |
| `logs/protocol_r….log`, `logs/log-errors.txt` | every kept log file |
| `updater/updater.log`, `updater/updater.log.old` | the updater's journal, from `updater::journal_dir` |
| `crash-report.json` | the pending crash report, if there is one |
| `speech-check/<name>` | the latest Speech check report: `latest_speech_check_report()` in `bundle.rs` is the one place to read it, `None` until #233 is in the app |

Every entry passes through `scrub::Identity`: the home folder becomes `~`
(also with forward slashes and as escaped in JSON, up to a word boundary) and
the user name becomes `<user>` (whole words, two letters or more). The save
dialog is the crash report's (`src/api/saveDialog.ts`, with its GTK `.zip`
re-ask); the default name is `Protocol-logs-<local date>.zip`. After saving,
the group names the file and offers **Show in folder**: Explorer and Finder
select it (`explorer /select,`, `open -R`), Linux opens its folder with
`xdg-open`.

## CLI modes

They keep their own logging and never write to the app's log: the macOS
audio-permission probe and the Linux MCP pass-through (`--mcp-server`) exit in
`main` before `init`; `measure` and the hardware qualification are `cargo test`
code that never runs `main` and starts `env_logger` itself.

## Tests

- `cargo test -p protocol --lib -- app_log`: rotation and the count limit at a
  small cap, a launch continuing the newest file, secret masking in a written
  line, scrubbing (Linux and Windows homes, whole-word user names), the ZIP's
  entries, missing folders, the `.zip`-only destination.
- `cargo test -p protocol --test app_log_panic`: a panic's thread, place and
  message reach the file (its own binary, for the global logger).
- `node --test "scripts/log-audit/test/*.test.mjs"` and
  `node scripts/log-audit/check-log-lines.mjs`.
- Frontend: `LogsGroup.test.tsx` (save, cancel, the failure state, the file
  name), `RouteError.test.tsx`, `src/api/logs.test.ts`; story
  `Shell/RouteError`.

## Limits

- Windows and macOS are proven only by compile checks in the release dry run:
  the folder on each, Explorer's and Finder's selection, and a GUI-subsystem
  Windows build's stderr (Rust treats the missing handle as a sink).
- A struct printed under a neutral name is outside the checker's reach.
- The panic message is the panic's own text; an `expect` on an error that
  carries content would print it (cut at 500 characters).
