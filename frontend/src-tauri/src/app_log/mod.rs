//! Protocol's log on disk (#234), so a tester can send it with a bug report.
//! `main.rs` calls [`init`] before Tauri starts; the files, their rotation
//! and what they never hold are described in docs/APP_LOG.md.

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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// One file stays easy to open in a text editor.
pub const FILE_CAP: u64 = 2 * 1024 * 1024;
/// Files kept, the current one included: at most 20 MiB, which deflates
/// under GitHub's 25 MB attachment limit and still holds many launches.
pub const FILES_KEPT: usize = 10;
/// How long a line waits in the writer's buffer. A process that ends without
/// [`shutdown`] (killed, or an exit outside `RunEvent::Exit`) loses at most
/// this much; flexi_logger's default of a second lost the lines just before
/// a crash, and 200 ms costs five small writes a second at most.
const FLUSH_INTERVAL: Duration = Duration::from_millis(200);

const BASENAME: &str = "protocol";
const SUFFIX: &str = "log";

static HANDLE: OnceLock<LoggerHandle> = OnceLock::new();
/// Why the log could not be started on disk, when it could not.
static START_ERROR: OnceLock<String> = OnceLock::new();

/// Info, except for libraries whose info lines are bookkeeping (ONNX Runtime's
/// arena lines, zbus's D-Bus handshakes); their warnings still come through.
fn level() -> LogSpecification {
    LogSpecification::builder()
        .default(log::LevelFilter::Info)
        .module("ort::logging", log::LevelFilter::Warn)
        .module("zbus", log::LevelFilter::Warn)
        .module("tracing::span", log::LevelFilter::Warn)
        .build()
}

pub fn logs_dir() -> PathBuf {
    crate::paths::install_data_root().join("logs")
}

/// flexi_logger's own errors in the middle of a run (a failed write or
/// rotation), which Settings shows. In the temporary folder, since the log
/// folder is the one failing, often on a full disk that the temporary folder
/// is not on; one per process, so a second launch does not read the first's.
pub fn errors_file() -> PathBuf {
    std::env::temp_dir().join(format!("protocol-log-errors-{}.txt", std::process::id()))
}

/// Starts the app's logger: the log folder and stderr, at the info level.
/// When the folder cannot be written the app logs to stderr only and
/// [`get_log_status`] reports why.
pub fn init() {
    init_in(&logs_dir());
}

/// [`init`] with the log in `dir`; tests give it a folder of their own.
pub fn init_in(dir: &Path) {
    let started = probe(dir)
        .map_err(FlexiLoggerError::from)
        .and_then(|()| file_logger(dir).start())
        .map_err(|error| format!("Protocol cannot write its log to {}: {error}", dir.display()))
        .or_else(|reason| {
            let _ = START_ERROR.set(reason);
            stderr_logger().start()
        });
    match started {
        Ok(handle) => {
            let _ = HANDLE.set(handle);
        }
        Err(error) => eprintln!("protocol: cannot start logging: {error}"),
    }
    if let Some(reason) = START_ERROR.get() {
        log::error!("{reason}");
    }

    // whisper.cpp's and ggml's own lines reach the log instead of stderr.
    whisper_rs::install_logging_hooks();
    // The data root's own lines ran before the logger existed.
    log::info!(
        "Protocol {} on {} {}, process {}, data root {} ({}), log folder {}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::process::id(),
        crate::paths::install_data_root().display(),
        crate::paths::data_root_origin(),
        dir.display()
    );
}

/// Writes into `dir`, as the logger will: flexi_logger opens its file only at
/// the first line, so `start` succeeds in a folder it cannot write.
fn probe(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    tempfile::tempfile_in(dir)?.write_all(b"probe")
}

fn file_spec(dir: &Path) -> FileSpec {
    FileSpec::default().directory(dir).basename(BASENAME).suffix(SUFFIX)
}

/// Files named after their start (`protocol_r2026-11-26_09-30-00.log`), a
/// new one past `cap` bytes, and the `kept` newest kept.
fn rotation(cap: u64, kept: usize) -> (Criterion, Naming, Cleanup) {
    (Criterion::Size(cap), Naming::TimestampsDirect, Cleanup::KeepLogFiles(kept))
}

fn file_logger(dir: &Path) -> Logger {
    let (criterion, naming, cleanup) = rotation(FILE_CAP, FILES_KEPT);
    Logger::with(level())
        .log_to_file(file_spec(dir))
        .rotate(criterion, naming, cleanup)
        // A launch continues the newest file; otherwise a second instance in
        // the same second would truncate the running one's (same name).
        .append()
        .write_mode(WriteMode::AsyncWith {
            pool_capa: flexi_logger::DEFAULT_POOL_CAPA,
            message_capa: flexi_logger::DEFAULT_MESSAGE_CAPA,
            flush_interval: FLUSH_INTERVAL,
        })
        .format(format_line)
        .duplicate_to_stderr(Duplicate::All)
        .error_channel(ErrorChannel::File(errors_file()))
        .panic_if_error_channel_is_broken(false)
}

fn stderr_logger() -> Logger {
    Logger::with(level())
        .log_to_stderr()
        .format(format_line)
        .panic_if_error_channel_is_broken(false)
}

/// `2026-11-26T09:30:00.123+03:00 INFO  target: message`, local time so a
/// tester's "it broke at half past nine" finds the line, secrets masked.
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

/// Asks the writer thread to write what it holds, without waiting.
pub fn flush() {
    if let Some(handle) = HANDLE.get() {
        handle.flush();
    }
}

/// Writes every line logged so far into `dir`'s newest file before it
/// returns, or gives up after `timeout`; for Save logs, which reads the files
/// next. flexi_logger's flush does not wait, so this logs a line of its own,
/// flushes, and waits for that line: the writer takes lines in order.
pub fn flush_and_wait(dir: &Path, timeout: Duration) {
    static SAVES: AtomicU64 = AtomicU64::new(0);
    if HANDLE.get().is_none() || START_ERROR.get().is_some() {
        return;
    }
    let line = format!("Saving the logs (save {})", SAVES.fetch_add(1, Ordering::Relaxed) + 1);
    log::info!("{line}");
    flush();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let written = bundle::log_files(dir)
            .ok()
            .and_then(|files| files.last().cloned())
            .and_then(|newest| fs::read(newest).ok())
            .is_some_and(|bytes| bytes.windows(line.len()).any(|window| window == line.as_bytes()));
        if written {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Writes every queued line and stops the writer thread; nothing logged after
/// this reaches the file. For the end of the process, where the static handle
/// is never dropped.
pub fn shutdown() {
    if let Some(handle) = HANDLE.get() {
        handle.shutdown();
    }
}

/// The panic's message and place in the log (`crash_report.rs`'s hook).
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStatus {
    /// Why the log is not, or not fully, written; `None` when it is.
    problem: Option<String>,
}

#[tauri::command]
pub fn get_log_status() -> LogStatus {
    let problem = START_ERROR.get().cloned().or_else(|| {
        let errors = fs::read_to_string(errors_file()).ok()?;
        let last = errors.lines().rev().find(|line| line.starts_with("[flexi_logger]"))?.trim();
        Some(format!("Protocol could not write part of its log: {last}"))
    });
    LogStatus { problem }
}

/// WebView errors logged in a minute, at most. A screen that throws on every
/// render logs dozens a second, which would push earlier launches out of the
/// kept files; one failing screen logs a few, well under this.
const WEBVIEW_ERRORS_PER_MINUTE: u32 = 30;

/// Counts the WebView's errors in the current minute.
struct Limiter {
    since: Instant,
    logged: u32,
    dropped: u32,
}

impl Limiter {
    /// Whether an error at `now` is logged, and how many were dropped in the
    /// minute that just ended, to say so once.
    fn admit(&mut self, now: Instant) -> (bool, u32) {
        let mut dropped = 0;
        if now.duration_since(self.since) >= Duration::from_secs(60) {
            dropped = std::mem::take(&mut self.dropped);
            self.since = now;
            self.logged = 0;
        }
        let admitted = self.logged < WEBVIEW_ERRORS_PER_MINUTE;
        if admitted {
            self.logged += 1;
        } else {
            self.dropped += 1;
        }
        (admitted, dropped)
    }
}

/// An error the WebView caught: an uncaught error, an unhandled rejection, or
/// one the route error screen showed. Its text is cut short, since a long one
/// is usually a dump of data rather than a message.
#[tauri::command]
pub fn log_webview_error(kind: String, message: String, stack: Option<String>) {
    static LIMITER: Mutex<Option<Limiter>> = Mutex::new(None);
    let (admitted, dropped) = {
        let mut limiter = LIMITER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        limiter.get_or_insert(Limiter { since: now, logged: 0, dropped: 0 }).admit(now)
    };
    if dropped > 0 {
        log::warn!(target: "webview", "{dropped} more errors in the last minute were not logged");
    }
    if !admitted {
        return;
    }
    let mut line = format!("{}: {}", shorten(&kind, 40), shorten(&message, 1000));
    if let Some(stack) = stack.filter(|value| !value.trim().is_empty()) {
        line.push('\n');
        line.push_str(&shorten(&stack, 2000));
    }
    // log-audit: the WebView's error text, cut short; screens do not throw content
    log::error!(target: "webview", "{line}");
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
        let (criterion, naming, cleanup) = rotation(cap, kept);
        FileLogWriter::builder(file_spec(dir))
            .rotate(criterion, naming, cleanup)
            .cleanup_in_background_thread(false)
            .append()
            .format(format_line)
            .try_build()
            .unwrap()
    }

    fn log_names(dir: &Path) -> Vec<String> {
        bundle::log_files(dir)
            .unwrap()
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
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

    #[cfg(unix)]
    #[test]
    fn the_probe_fails_in_a_folder_it_cannot_write() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        assert!(probe(&logs).is_ok());
        assert_eq!(fs::read_dir(&logs).unwrap().count(), 0, "the probe leaves no file");
        fs::set_permissions(&logs, fs::Permissions::from_mode(0o555)).unwrap();
        // Root writes anywhere; the check means nothing there.
        if fs::write(logs.join("x"), "x").is_err() {
            assert!(probe(&logs).is_err());
        }
    }

    #[test]
    fn webview_errors_past_the_limit_are_counted_and_reported_once() {
        let start = Instant::now();
        let mut limiter = Limiter { since: start, logged: 0, dropped: 0 };
        let admitted = (0..40).filter(|_| limiter.admit(start).0).count();
        assert_eq!(admitted, WEBVIEW_ERRORS_PER_MINUTE as usize);
        assert_eq!(limiter.admit(start + Duration::from_secs(61)), (true, 10));
        assert_eq!(limiter.admit(start + Duration::from_secs(62)), (true, 0));
    }

    #[test]
    fn long_text_is_cut_and_marked() {
        assert_eq!(shorten("short", 10), "short");
        assert_eq!(shorten("abcdef", 3), "abc… [3 more bytes]");
        assert_eq!(shorten("ыыы", 1), "ы… [4 more bytes]");
    }
}
