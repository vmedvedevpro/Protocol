//! Protocol's log on disk (#234), so a tester can send it with a bug report.
//!
//! `main.rs` calls [`init`] as its first step after the CLI modes have
//! exited, before Tauri starts: the `log` crate takes one global logger, and
//! lines from the data-root resolution, the panic hook and plugin start would
//! be lost to a logger set up in `.setup`. flexi_logger writes the files from
//! its own thread ([`WriteMode::Async`], an unbounded channel), so a log call
//! on a capture or inference thread never waits for the disk, and copies each
//! line to stderr for a run from a terminal.
//!
//! The folder is `<install data root>/logs` (`paths.rs`), beside
//! `crash-reports/`. A launch continues the newest file and each line's time
//! tells the launches apart (each starts with a `Protocol <version> on …`
//! line); past [`FILE_CAP`] a new file starts, named after its start time,
//! and the oldest go past [`FILES_KEPT`].
//!
//! The CLI modes keep their own logging: the macOS audio-permission probe and
//! the Linux MCP pass-through exit in `main` before [`init`], and the
//! `measure` and hardware-qualification modes are `cargo test` code that never
//! runs `main` and starts `env_logger` itself.

pub mod bundle;
pub mod scrub;

use flexi_logger::{
    Cleanup, Criterion, DeferredNow, Duplicate, ErrorChannel, FileSpec, FlexiLoggerError,
    LogSpecification, Logger, LoggerHandle, Naming, WriteMode,
};
use serde::Serialize;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// One file stays easy to open in a text editor, and the cleanup removes
/// history in steps no larger than this.
pub const FILE_CAP: u64 = 2 * 1024 * 1024;
/// Files kept, the current one included (flexi_logger's `KeepLogFiles`
/// counts it), so the folder holds at most `FILES_KEPT × FILE_CAP` = 20 MiB.
/// That deflates to a ZIP of a few MiB, under GitHub's 25 MB attachment
/// limit, and holds many launches, so the one that went wrong is still there
/// after a few restarts. A launch loses its first lines only when the
/// launches after it write more than that.
pub const FILES_KEPT: usize = 10;

const BASENAME: &str = "protocol";
const SUFFIX: &str = "log";
/// flexi_logger's own errors (a failed write, a failed rotation), which
/// Settings shows next to Save logs. Cleared at each launch.
const ERRORS_FILE: &str = "log-errors.txt";

static HANDLE: OnceLock<LoggerHandle> = OnceLock::new();
/// Why the log could not be started on disk, when it could not.
static START_ERROR: OnceLock<String> = OnceLock::new();

pub fn logs_dir() -> PathBuf {
    crate::paths::install_data_root().join("logs")
}

/// Starts the app's logger: the log folder and stderr, at the info level.
/// When the folder cannot be written the app logs to stderr only and
/// [`get_log_status`] reports why.
pub fn init() {
    let dir = logs_dir();
    // Errors left by an earlier launch would read as this one's.
    let _ = fs::remove_file(dir.join(ERRORS_FILE));
    match fs::create_dir_all(&dir)
        .map_err(FlexiLoggerError::from)
        .and_then(|()| file_logger(&dir).start())
    {
        Ok(handle) => {
            let _ = HANDLE.set(handle);
        }
        Err(error) => {
            let reason = format!("Protocol cannot write its log to {}: {error}", dir.display());
            let fallback = Logger::with(LogSpecification::info())
                .log_to_stderr()
                .format(format_line)
                .panic_if_error_channel_is_broken(false)
                .start();
            match fallback {
                Ok(handle) => {
                    let _ = HANDLE.set(handle);
                }
                Err(error) => eprintln!("protocol: cannot start logging: {error}"),
            }
            log::error!("{reason}");
            let _ = START_ERROR.set(reason);
        }
    }

    // whisper.cpp's and ggml's own lines (model load, the devices and
    // backends they found) reach the log at their own level instead of
    // stderr.
    whisper_rs::install_logging_hooks();
    log::info!(
        "Protocol {} on {} {}, log folder {}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        dir.display()
    );
}

fn file_spec(dir: &Path) -> FileSpec {
    FileSpec::default()
        .directory(dir)
        .basename(BASENAME)
        .suffix(SUFFIX)
}

/// Files named after their start (`protocol_r2026-11-26_09-30-00.log`), a
/// new one past [`FILE_CAP`], and the [`FILES_KEPT`] newest kept.
fn rotation() -> (Criterion, Naming, Cleanup) {
    (
        Criterion::Size(FILE_CAP),
        Naming::TimestampsDirect,
        Cleanup::KeepLogFiles(FILES_KEPT),
    )
}

fn file_logger(dir: &Path) -> Logger {
    let (criterion, naming, cleanup) = rotation();
    Logger::with(LogSpecification::info())
        .log_to_file(file_spec(dir))
        .rotate(criterion, naming, cleanup)
        // A launch continues the newest file. Without this each launch would
        // open a file named after the current second and truncate it, so a
        // second instance started within the same second (a double click)
        // would cut the running one's log.
        .append()
        .write_mode(WriteMode::Async)
        .format(format_line)
        .duplicate_to_stderr(Duplicate::All)
        .error_channel(ErrorChannel::File(dir.join(ERRORS_FILE)))
        // A broken error channel must not take the app down with it.
        .panic_if_error_channel_is_broken(false)
}

/// `2026-11-26T09:30:00.123+03:00 INFO  target: message`, local time so a
/// tester's "it broke at half past nine" finds the line, with secrets masked
/// ([`scrub::secrets`]).
fn format_line(write: &mut dyn Write, now: &mut DeferredNow, record: &log::Record) -> io::Result<()> {
    let message = record.args().to_string();
    write!(
        write,
        "{} {:<5} {}: {}",
        now.format("%Y-%m-%dT%H:%M:%S%.3f%:z"),
        record.level(),
        record.target(),
        scrub::secrets(&message)
    )
}

/// Asks the writer thread to write what it holds. It does not wait: lines
/// logged just before can still be on their way.
pub fn flush() {
    if let Some(handle) = HANDLE.get() {
        handle.flush();
    }
}

/// Writes every queued line and stops the writer thread; nothing logged after
/// this reaches the file. For the end of the process, where the static handle
/// is never dropped and [`flush`] alone could lose the last lines.
pub fn shutdown() {
    if let Some(handle) = HANDLE.get() {
        handle.shutdown();
    }
}

/// The panic's message and location in the log, next to the crash report's
/// record (`crash_report.rs` calls this from its hook).
pub fn record_panic(info: &std::panic::PanicHookInfo<'_>) {
    let thread = std::thread::current();
    let name = thread.name().unwrap_or("unnamed");
    let location = info
        .location()
        .map(|place| format!("{}:{}:{}", place.file(), place.line(), place.column()))
        .unwrap_or_else(|| "an unknown place".to_string());
    let message = info.payload_as_str().unwrap_or("a non-text payload");
    log::error!(target: "panic", "thread '{name}' panicked at {location}: {}", shorten(message, 500));
    // The main thread's panic ends the process; any other thread's leaves the
    // app running, and a stopped writer would lose the rest of its log.
    if name == "main" {
        shutdown();
    } else {
        flush();
    }
}

/// At most `max` characters, marked when cut.
fn shorten(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((end, _)) => format!("{}… [{} more bytes]", &text[..end], text.len() - end),
        None => text.to_string(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStatus {
    folder: String,
    /// Why the log is not, or not fully, written; `None` when it is.
    problem: Option<String>,
}

#[tauri::command]
pub fn get_log_status() -> LogStatus {
    let dir = logs_dir();
    let problem = START_ERROR.get().cloned().or_else(|| {
        let errors = fs::read_to_string(dir.join(ERRORS_FILE)).ok()?;
        let last = errors
            .lines()
            .rev()
            .find(|line| line.starts_with("[flexi_logger]"))?
            .trim();
        Some(format!("Protocol could not write part of its log: {last}"))
    });
    LogStatus {
        folder: dir.display().to_string(),
        problem,
    }
}

/// An error the WebView caught: an uncaught error, an unhandled rejection, or
/// one the route error screen showed. Its text is cut short, since a long one
/// is usually a dump of data rather than a message.
#[tauri::command]
pub fn log_webview_error(kind: String, message: String, stack: Option<String>) {
    let kind = shorten(&kind, 40);
    let message = shorten(&message, 1000);
    match stack.filter(|value| !value.trim().is_empty()) {
        Some(stack) => log::error!(target: "webview", "{kind}: {message}\n{}", shorten(&stack, 2000)),
        None => log::error!(target: "webview", "{kind}: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flexi_logger::writers::{FileLogWriter, LogWriter};

    fn write_lines(writer: &FileLogWriter, count: usize, line: &str) {
        for _ in 0..count {
            writer
                .write(
                    &mut DeferredNow::new(),
                    &log::Record::builder()
                        .args(format_args!("{line}"))
                        .level(log::Level::Info)
                        .target("test")
                        .build(),
                )
                .unwrap();
        }
        writer.flush().unwrap();
    }

    fn writer(dir: &Path, cap: u64, kept: usize) -> FileLogWriter {
        let (_, naming, _) = rotation();
        FileLogWriter::builder(file_spec(dir))
            .rotate(Criterion::Size(cap), naming, Cleanup::KeepLogFiles(kept))
            .cleanup_in_background_thread(false)
            .append()
            .format(format_line)
            .try_build()
            .unwrap()
    }

    fn log_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("protocol_") && name.ends_with(".log"))
            .collect();
        names.sort();
        names
    }

    /// The configuration `init` uses, at a small cap: past the cap a new file
    /// starts, and only the `kept` newest files stay.
    #[test]
    fn files_rotate_past_the_cap_and_the_oldest_go() {
        let dir = tempfile::tempdir().unwrap();
        let writer = writer(dir.path(), 1024, 2);
        // About 100 bytes a line: each 20 lines fill a file and a half.
        for _ in 0..6 {
            write_lines(&writer, 20, &"x".repeat(60));
        }
        writer.shutdown();
        let names = log_names(dir.path());
        assert_eq!(names.len(), 2, "{names:?}");
        for name in &names {
            let size = fs::metadata(dir.path().join(name)).unwrap().len();
            // A file is closed at the first line past the cap.
            assert!(size <= 1024 + 200, "{name} is {size} bytes");
        }
    }

    /// A launch keeps what the earlier ones wrote, even one started within
    /// the same second, whose file name would be the same.
    #[test]
    fn a_launch_continues_the_newest_file() {
        let dir = tempfile::tempdir().unwrap();
        for launch in ["first launch", "second launch"] {
            let writer = writer(dir.path(), FILE_CAP, FILES_KEPT);
            write_lines(&writer, 1, launch);
            writer.shutdown();
        }
        let names = log_names(dir.path());
        assert_eq!(names.len(), 1, "{names:?}");
        let text = fs::read_to_string(dir.path().join(&names[0])).unwrap();
        assert!(text.contains("INFO  test: first launch") && text.contains("second launch"), "{text}");
    }

    #[test]
    fn lines_mask_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let writer = writer(dir.path(), FILE_CAP, FILES_KEPT);
        write_lines(&writer, 1, "request with api_key=abc123 failed");
        writer.shutdown();
        let text = fs::read_to_string(dir.path().join(&log_names(dir.path())[0])).unwrap();
        assert!(text.contains("api_key=<redacted>") && !text.contains("abc123"), "{text}");
    }

    #[test]
    fn long_text_is_cut_and_marked() {
        assert_eq!(shorten("short", 10), "short");
        assert_eq!(shorten("abcdef", 3), "abc… [3 more bytes]");
        assert_eq!(shorten("ыыы", 1), "ы… [4 more bytes]");
    }
}
