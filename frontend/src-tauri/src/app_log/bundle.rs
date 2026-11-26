//! Save logs (Settings › Advanced): one ZIP with what a bug report needs.
//!
//! Every text file in it passes through [`Identity::scrub`]: the home folder
//! becomes `~` and the user name `<user>`. What the log itself never holds
//! (meeting content, secrets) is kept out where each line is written.

use super::scrub::Identity;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};
use tempfile::NamedTempFile;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const README: &str = "Protocol logs

Saved with Settings > Advanced > Save logs, to attach to a bug report.

Included:
- logs/: Protocol's log of its last launches, one file per launch, named
  after its start time. Native messages, the speech engines' own messages
  (model loading, the devices and backends they use), panics, and errors
  from the window.
- updater/: what the in-app updater did (checks, downloads, installs).
- crash-report.json: the crash report Protocol offered after its last crash,
  if it is still waiting to be sent or dismissed.
- speech-check/: the latest Speech check report, if one exists.
- system.txt: Protocol's version, the operating system, the architecture and
  the acceleration backend.

In this copy, paths under your home folder start with ~ and your user name
reads <user>.

Not included:
- Recordings, transcripts, summaries, notes, prompts and model replies
- API keys and tokens
- Protocol's database, settings and models

The log can name meeting titles, audio devices, models and files where a bug
needs them. Read the files before you send them if that matters to you.
";

/// What goes into the ZIP, gathered by the command and given here so tests
/// can use a folder of their own.
pub struct Sources {
    pub logs_dir: PathBuf,
    pub updater_dir: Option<PathBuf>,
    pub crash_report: Option<Vec<u8>>,
    /// The file name and contents of the latest Speech check report.
    pub speech_check: Option<(String, Vec<u8>)>,
    pub system: String,
}

/// The latest Speech check report (#233), when that feature is in the app.
/// This is the one place to read it from; until then there is none.
fn latest_speech_check_report() -> Option<(String, Vec<u8>)> {
    None
}

/// Writes the ZIP to `destination` (through a temporary file beside it, so a
/// failed save leaves no half file) and returns the names inside it.
pub fn write_bundle(destination: &Path, sources: &Sources, identity: &Identity) -> io::Result<Vec<String>> {
    if !destination
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("zip"))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "The logs can only be saved as a .zip file",
        ));
    }
    let parent = match destination.parent() {
        Some(parent) if parent.as_os_str().is_empty() => Path::new("."),
        Some(parent) => parent,
        None => Path::new("."),
    };
    if !parent.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "The folder to save in does not exist"));
    }

    let mut entries: Vec<(String, Vec<u8>)> = vec![
        ("README.txt".to_string(), README.as_bytes().to_vec()),
        ("system.txt".to_string(), sources.system.as_bytes().to_vec()),
    ];
    for path in files_in(&sources.logs_dir, |name| {
        (name.starts_with("protocol_") && name.ends_with(".log")) || name == super::ERRORS_FILE
    })? {
        entries.push((format!("logs/{}", file_name(&path)), fs::read(&path)?));
    }
    if let Some(dir) = &sources.updater_dir {
        for path in files_in(dir, |name| name == "updater.log" || name == "updater.log.old")? {
            entries.push((format!("updater/{}", file_name(&path)), fs::read(&path)?));
        }
    }
    if let Some(report) = &sources.crash_report {
        entries.push(("crash-report.json".to_string(), report.clone()));
    }
    if let Some((name, report)) = &sources.speech_check {
        entries.push((format!("speech-check/{name}"), report.clone()));
    }

    let mut temporary = NamedTempFile::new_in(parent)?;
    {
        let mut zip = ZipWriter::new(temporary.as_file_mut());
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        for (name, bytes) in &entries {
            zip.start_file(name.as_str(), options)?;
            zip.write_all(identity.scrub(&String::from_utf8_lossy(bytes)).as_bytes())?;
        }
        zip.finish()?;
    }
    temporary.as_file().sync_all()?;
    temporary.persist(destination).map_err(|error| error.error)?;
    Ok(entries.into_iter().map(|(name, _)| name).collect())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The files in `dir` whose names pass `keep`, sorted by name (the log
/// files' start times sort as text); none when `dir` is missing.
fn files_in(dir: &Path, keep: impl Fn(&str) -> bool) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && keep(&file_name(path)))
        .collect();
    files.sort();
    Ok(files)
}

/// Saves the ZIP to the path the save dialog returned and returns it.
#[tauri::command]
pub async fn save_logs_zip<R: Runtime>(app: AppHandle<R>, destination: String) -> Result<String, String> {
    log::info!("Saving the logs to a ZIP");
    // Ask the writer for what it holds; the line above may still be on its way.
    super::flush();
    let sources = Sources {
        logs_dir: super::logs_dir(),
        updater_dir: Some(crate::updater::journal_dir(&app)),
        crash_report: crate::crash_report::pending_report_json(),
        speech_check: latest_speech_check_report(),
        system: crate::crash_report::system_summary(),
    };
    let destination = PathBuf::from(destination);
    let target = destination.clone();
    let names = tauri::async_runtime::spawn_blocking(move || {
        write_bundle(&target, &sources, &Identity::current())
    })
    .await
    .map_err(|error| format!("Could not save the logs: {error}"))?
    .map_err(|error| format!("Could not save the logs: {error}"))?;
    log::info!("Saved the logs ZIP with {} files", names.len());
    Ok(destination.to_string_lossy().into_owned())
}

/// Shows the saved ZIP in the file manager: selected in Explorer and Finder,
/// its folder on Linux, where no common way to select a file exists.
#[tauri::command]
pub fn show_saved_logs(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_file() || !path.extension().is_some_and(|value| value.eq_ignore_ascii_case("zip")) {
        return Err("The saved logs file is no longer there".to_string());
    }
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        // raw_arg: Explorer reads /select,"path" and not a quoted whole.
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg("-R").arg(&path).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open")
        .arg(path.parent().unwrap_or_else(|| Path::new(".")))
        .spawn();
    result
        .map(|_| ())
        .map_err(|error| format!("Could not open the file manager: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use zip::ZipArchive;

    fn read_zip(path: &Path) -> Vec<(String, String)> {
        let mut archive = ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        (0..archive.len())
            .map(|index| {
                let mut file = archive.by_index(index).unwrap();
                let mut text = String::new();
                file.read_to_string(&mut text).unwrap();
                (file.name().to_string(), text)
            })
            .collect()
    }

    #[test]
    fn the_zip_holds_the_logs_the_journal_the_report_and_a_readme() {
        let temp = tempfile::tempdir().unwrap();
        let logs = temp.path().join("logs");
        let updates = temp.path().join("updates");
        fs::create_dir_all(&logs).unwrap();
        fs::create_dir_all(&updates).unwrap();
        fs::write(logs.join("protocol_r2026-11-25_09-00-00.log"), "older launch").unwrap();
        fs::write(
            logs.join("protocol_r2026-11-26_09-00-00.log"),
            "model at /home/anna/.local/share/x for anna",
        )
        .unwrap();
        fs::write(logs.join("log-errors.txt"), "[flexi_logger] write failed").unwrap();
        fs::write(logs.join("notes.txt"), "not a log").unwrap();
        fs::write(updates.join("updater.log"), "check started").unwrap();
        fs::write(updates.join("cache.bin"), "not a log").unwrap();
        let sources = Sources {
            logs_dir: logs,
            updater_dir: Some(updates),
            crash_report: Some(br#"{"crashType":"panic","path":"/home/anna/x"}"#.to_vec()),
            speech_check: Some(("speech-check.json".to_string(), b"{}".to_vec())),
            system: "Protocol 1.0.0\n".to_string(),
        };
        let destination = temp.path().join("Protocol-logs.zip");

        let names = write_bundle(&destination, &sources, &Identity::new(Some("/home/anna"), Some("anna"))).unwrap();

        let files = read_zip(&destination);
        let zipped: Vec<&str> = files.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, zipped);
        assert_eq!(
            zipped,
            [
                "README.txt",
                "system.txt",
                "logs/log-errors.txt",
                "logs/protocol_r2026-11-25_09-00-00.log",
                "logs/protocol_r2026-11-26_09-00-00.log",
                "updater/updater.log",
                "crash-report.json",
                "speech-check/speech-check.json",
            ]
        );
        let text = |name: &str| files.iter().find(|(file, _)| file == name).unwrap().1.clone();
        assert_eq!(text("logs/protocol_r2026-11-26_09-00-00.log"), "model at ~/.local/share/x for <user>");
        assert_eq!(text("crash-report.json"), r#"{"crashType":"panic","path":"~/x"}"#);
        assert!(text("README.txt").contains("Not included:"));
    }

    #[test]
    fn missing_folders_still_make_a_zip() {
        let temp = tempfile::tempdir().unwrap();
        let sources = Sources {
            logs_dir: temp.path().join("absent"),
            updater_dir: None,
            crash_report: None,
            speech_check: None,
            system: String::new(),
        };
        let destination = temp.path().join("logs.ZIP");
        let names = write_bundle(&destination, &sources, &Identity::new(None, None)).unwrap();
        assert_eq!(names, ["README.txt", "system.txt"]);
    }

    #[test]
    fn only_a_zip_in_an_existing_folder_is_written() {
        let temp = tempfile::tempdir().unwrap();
        let sources = Sources {
            logs_dir: temp.path().to_path_buf(),
            updater_dir: None,
            crash_report: None,
            speech_check: None,
            system: String::new(),
        };
        let identity = Identity::new(None, None);
        assert!(write_bundle(&temp.path().join("logs"), &sources, &identity).is_err());
        assert!(write_bundle(&temp.path().join("absent/logs.zip"), &sources, &identity).is_err());
    }
}
