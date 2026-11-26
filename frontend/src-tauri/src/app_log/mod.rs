//! Protocol's log on disk (#234), so a tester can send it with a bug report.
//! `main.rs` calls [`init`] before Tauri starts; the files, their rotation
//! and what they never hold are described in docs/APP_LOG.md.

pub mod bundle;
pub mod scrub;

use flexi_logger::{
    Cleanup, Criterion, DeferredNow, Duplicate, ErrorChannel, FileSpec,
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

/// Tauri's bundle identifier (`tauri.conf.json`), which names the app's
/// cache folder; a test keeps the two the same.
const BUNDLE_IDENTIFIER: &str = "io.github.vmedvedevpro.protocol";

/// flexi_logger's own errors in the middle of a run (a failed write or
/// rotation), which Settings shows. Outside the log folder, which is the one
/// failing, and one per process, so a second launch does not read the first's.
pub fn errors_file() -> PathBuf {
    errors_dir().join(format!("protocol-log-errors-{}.txt", std::process::id()))
}

/// The app's own cache folder, as Tauri's `app_cache_dir` names it (`init`
/// runs before Tauri, so it cannot ask), and not the shared temporary folder,
/// where another user could plant a link at the predictable name. The data
/// root's `cache` when the OS has no cache folder, as the updater's falls back.
fn errors_dir() -> PathBuf {
    dirs::cache_dir()
        .map(|cache| cache.join(BUNDLE_IDENTIFIER))
        .unwrap_or_else(|| crate::paths::install_data_root().join("cache"))
        .join("log-errors")
}

/// Starts the app's logger: the log folder and stderr, at the info level.
/// When the folder cannot be written the app logs to stderr only and
/// [`get_log_status`] reports why.
pub fn init() {
    init_in(&logs_dir());
}

/// [`init`] with the log in `dir`; tests give it a folder of their own.
pub fn init_in(dir: &Path) {
    // A file left by an earlier process with the same id (Windows reuses
    // them soon) would report its errors as this run's.
    let errors = errors_file();
    let _ = fs::remove_file(&errors);
    if let Some(parent) = errors.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // The probe's own error: flexi_logger's wrapper drops the OS's reason.
    let started = probe(dir)
        .map_err(|error| error.to_string())
        .and_then(|()| file_logger(dir).start().map_err(|error| error.to_string()))
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
    let marker = save_marker(SAVES.fetch_add(1, Ordering::Relaxed) + 1);
    log::info!("{marker}");
    flush();
    wait_for_line(dir, &marker, timeout);
}

/// The line a save waits for. Launches append to the same newest file and
/// each counts its saves from 1, so the process id tells this one's line
/// from an earlier launch's; the closing parenthesis keeps save 1 from
/// matching save 10.
fn save_marker(save: u64) -> String {
    format!("Saving the logs (process {}, save {save})", std::process::id())
}

/// Whether `line` reached `dir`'s newest log file within `timeout`.
fn wait_for_line(dir: &Path, line: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let written = bundle::log_files(dir)
            .ok()
            .and_then(|files| files.last().cloned())
            .and_then(|newest| fs::read(newest).ok())
            .is_some_and(|bytes| bytes.windows(line.len()).any(|window| window == line.as_bytes()));
        if written {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
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
    // log-audit: the panic's own text, cut short (docs/APP_LOG.md, Limits)
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

/// A JSON error for the log: its kind and place. serde's own text quotes
/// the value it could not read, which can be a stored transcript or summary.
pub fn json_error(error: &serde_json::Error) -> String {
    format!("{:?} error at line {}, column {}", error.classify(), error.line(), error.column())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStatus {
    /// Why the log is not, or not fully, written; `None` when it is.
    problem: Option<String>,
}

#[tauri::command]
pub fn get_log_status() -> LogStatus {
    LogStatus { problem: START_ERROR.get().cloned().or_else(|| write_problem(&errors_file())) }
}

/// The last error flexi_logger wrote into `errors_file`, for Settings; `None`
/// when there is none or the file is missing.
fn write_problem(errors_file: &Path) -> Option<String> {
    let errors = fs::read_to_string(errors_file).ok()?;
    let last = errors.lines().rev().find(|line| line.starts_with("[flexi_logger]"))?.trim();
    Some(format!("Protocol could not write part of its log: {last}"))
}

/// WebView errors logged in a minute, at most. A screen that throws on every
/// render logs dozens a second, which would push earlier launches out of the
/// kept files; one failing screen logs a few, well under this.
const WEBVIEW_ERRORS_PER_MINUTE: u32 = 30;

/// What [`Limiter::admit`] decides for one error.
#[derive(Debug, PartialEq)]
enum Admission {
    Log,
    /// The first error past the limit: dropped, with one line saying so, so
    /// a burst that then stops is still seen.
    Silence,
    Drop,
}

/// Counts the WebView's errors in the current minute.
struct Limiter {
    /// When the minute started; `None` before the first error.
    since: Option<Instant>,
    seen: u32,
}

impl Limiter {
    const fn new() -> Self {
        Self { since: None, seen: 0 }
    }

    fn admit(&mut self, now: Instant) -> Admission {
        if self.since.is_none_or(|since| now.duration_since(since) >= Duration::from_secs(60)) {
            self.since = Some(now);
            self.seen = 0;
        }
        self.seen = self.seen.saturating_add(1);
        match self.seen {
            seen if seen <= WEBVIEW_ERRORS_PER_MINUTE => Admission::Log,
            seen if seen == WEBVIEW_ERRORS_PER_MINUTE + 1 => Admission::Silence,
            _ => Admission::Drop,
        }
    }
}

/// An error the WebView caught: an uncaught error, an unhandled rejection, or
/// one the route error screen showed. Its text is cut short, since a long one
/// is usually a dump of data rather than a message.
#[tauri::command]
pub fn log_webview_error(kind: String, message: String, stack: Option<String>) {
    static LIMITER: Mutex<Limiter> = Mutex::new(Limiter::new());
    let admission = LIMITER.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).admit(Instant::now());
    match admission {
        Admission::Log => {}
        Admission::Silence => {
            log::warn!(
                target: "webview",
                "More than {WEBVIEW_ERRORS_PER_MINUTE} errors this minute; further WebView errors are not logged until the minute ends"
            );
            return;
        }
        Admission::Drop => return,
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

    /// The first error past the limit says so at once, so a burst that
    /// stops is still seen; the minute after starts over.
    #[test]
    fn webview_errors_past_the_limit_are_announced_once_and_dropped() {
        let start = Instant::now();
        let mut limiter = Limiter::new();
        let admissions: Vec<Admission> = (0..40).map(|_| limiter.admit(start)).collect();
        let limit = WEBVIEW_ERRORS_PER_MINUTE as usize;
        assert!(admissions[..limit].iter().all(|admission| *admission == Admission::Log));
        assert_eq!(admissions[limit], Admission::Silence);
        assert!(admissions[limit + 1..].iter().all(|admission| *admission == Admission::Drop));
        assert_eq!(limiter.admit(start + Duration::from_secs(59)), Admission::Drop);
        assert_eq!(limiter.admit(start + Duration::from_secs(60)), Admission::Log);
    }

    /// A launch's marker already in the file does not end the wait: the
    /// newest file holds every launch's lines, each counting from save 1.
    #[test]
    fn a_save_waits_for_its_own_marker_and_not_an_earlier_launchs() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("protocol_r2026-11-26_09-00-00.log");
        let marker = save_marker(1);
        let earlier = marker.replace(&format!("process {}", std::process::id()), "process 1");
        assert_ne!(earlier, marker);
        fs::write(&file, format!("{earlier}\n{}\n", save_marker(10))).unwrap();
        assert!(!wait_for_line(dir.path(), &marker, Duration::from_millis(50)));
        fs::write(&file, format!("{earlier}\n{marker}\n")).unwrap();
        assert!(wait_for_line(dir.path(), &marker, Duration::ZERO));
    }

    #[test]
    fn the_error_file_reports_its_last_flexi_logger_line() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("errors.txt");
        assert_eq!(write_problem(&file), None);
        fs::write(&file, "[flexi_logger] first failure\n  caused by: a detail\n[flexi_logger] disk full \n").unwrap();
        assert_eq!(write_problem(&file).as_deref(), Some("Protocol could not write part of its log: [flexi_logger] disk full"));
        fs::write(&file, "not from flexi_logger\n").unwrap();
        assert_eq!(write_problem(&file), None);
    }

    /// The error file is in the app's own cache folder, which Tauri names
    /// after the bundle identifier.
    #[test]
    fn the_error_file_is_in_the_apps_cache_folder() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], BUNDLE_IDENTIFIER);
        let file = errors_file();
        assert!(file.starts_with(dirs::cache_dir().unwrap().join(BUNDLE_IDENTIFIER)), "{}", file.display());
        assert!(file.ends_with(format!("protocol-log-errors-{}.txt", std::process::id())));
    }

    #[test]
    fn a_json_error_names_its_place_and_not_the_value() {
        let error = serde_json::from_str::<u32>(r#""the transcript""#).unwrap_err();
        assert_eq!(json_error(&error), "Data error at line 1, column 16");
    }

    #[test]
    fn long_text_is_cut_and_marked() {
        assert_eq!(shorten("short", 10), "short");
        assert_eq!(shorten("abcdef", 3), "abc… [3 more bytes]");
        assert_eq!(shorten("ыыы", 1), "ы… [4 more bytes]");
    }
}
