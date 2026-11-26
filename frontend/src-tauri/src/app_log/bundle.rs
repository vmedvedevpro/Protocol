//! Save logs (Settings › Advanced): one ZIP with what a bug report needs,
//! each file passed through [`Identity::scrub`].

use super::scrub::Identity;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Runtime};

const README: &str = "Protocol logs

Saved with Settings > Advanced > Save logs, to attach to a bug report.

Included:
- logs/: Protocol's log. Each launch adds to the newest file, a new file
  starts past 2 MiB, and the 10 newest files are kept. It holds native
  messages, the speech engines' own messages (model loading, the devices and
  backends they use), panics, and errors from the window.
- logs/log-errors.txt: errors Protocol had writing its log, if any.
- updater/: what the in-app updater did (checks, downloads, installs).
- crash-report.json: the crash report Protocol offered after its last crash,
  if it is still waiting to be sent or dismissed.
- system.txt: Protocol's version, the operating system, the architecture and
  the acceleration backend.
- unreadable.txt: files that could not be read, if any.

In this copy, paths under your home folder start with ~ and your user name
reads <user>. API keys, bearer tokens and passwords in addresses are masked
as each line is written.

What the log can hold: meeting titles, file and folder names, audio device
and model names, service addresses (without credentials or query), and error
messages. Its lines are written to leave out recordings, transcript text,
summaries, notes, prompts and model replies, and a check of Protocol's source
keeps them so, but an error message from a library can still quote what it
was given. Read the files before you send them if that matters to you.

Not included: Protocol's database, settings, recordings and models.
";

/// What goes into the ZIP, gathered by the command and given here so tests
/// can use a folder of their own.
pub struct Sources {
    pub logs_dir: PathBuf,
    pub errors_file: PathBuf,
    pub updater_dir: PathBuf,
    pub crash_report: Option<Vec<u8>>,
    pub system: String,
}

/// Writes the ZIP to `destination` and returns how many files it holds. A
/// file that cannot be read is left out and named in `unreadable.txt`.
pub fn write_bundle(destination: &Path, sources: &Sources, identity: &Identity) -> io::Result<usize> {
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for path in log_files(&sources.logs_dir)? {
        files.push((format!("logs/{}", file_name(&path)), path));
    }
    if sources.errors_file.is_file() {
        files.push(("logs/log-errors.txt".to_string(), sources.errors_file.clone()));
    }
    for path in files_in(&sources.updater_dir, |name| name == "updater.log" || name == "updater.log.old")? {
        files.push((format!("updater/{}", file_name(&path)), path));
    }

    crate::zip_util::write_zip(destination, |zip| {
        let mut add = |name: &str, text: &str| zip.add(name, identity.scrub(text).as_bytes());
        add("README.txt", README)?;
        add("system.txt", &sources.system)?;
        let mut unreadable = Vec::new();
        for (name, path) in &files {
            match fs::read(path) {
                Ok(bytes) => add(name, &String::from_utf8_lossy(&bytes))?,
                Err(error) => unreadable.push(format!("{name}: {error}")),
            }
        }
        if let Some(report) = &sources.crash_report {
            add("crash-report.json", &String::from_utf8_lossy(report))?;
        }
        if !unreadable.is_empty() {
            add("unreadable.txt", &format!("Left out, since they could not be read:\n{}\n", unreadable.join("\n")))?;
        }
        Ok(())
    })
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The log files in `dir`, oldest first: their names hold their start time.
pub(super) fn log_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    files_in(dir, |name| name.starts_with("protocol_") && name.ends_with(".log"))
}

/// The files in `dir` whose names pass `keep`, sorted by name; none when
/// `dir` is missing.
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

/// Saves the ZIP to the path the save dialog returned.
#[tauri::command]
pub async fn save_logs_zip<R: Runtime>(app: AppHandle<R>, destination: String) -> Result<(), String> {
    let sources = Sources {
        logs_dir: super::logs_dir(),
        errors_file: super::errors_file(),
        updater_dir: crate::updater::journal_dir(&app),
        crash_report: crate::crash_report::pending_report_json(),
        system: crate::crash_report::system_summary(),
    };
    let count = tauri::async_runtime::spawn_blocking(move || {
        // Every line so far, this save's own included, before the files are read.
        super::flush_and_wait(&sources.logs_dir, Duration::from_secs(2));
        write_bundle(Path::new(&destination), &sources, &Identity::current())
    })
    .await
    .map_err(|error| format!("Could not save the logs: {error}"))?
    .map_err(|error| format!("Could not save the logs: {error}"))?;
    log::info!("Saved the logs ZIP with {count} files");
    Ok(())
}

/// Shows the saved ZIP in the file manager.
#[tauri::command]
pub fn show_saved_logs(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_file() || !crate::zip_util::is_zip(&path) {
        return Err("The saved logs file is no longer there".to_string());
    }
    crate::paths::open_in_system(path.as_os_str(), true).map_err(|error| format!("Could not open the file manager: {error}"))
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

    fn sources(root: &Path) -> Sources {
        Sources {
            logs_dir: root.join("logs"),
            errors_file: root.join("log-errors.txt"),
            updater_dir: root.join("updates"),
            crash_report: None,
            system: "Protocol 1.0.0\n".to_string(),
        }
    }

    #[test]
    fn the_zip_holds_the_logs_the_journal_the_report_and_a_readme() {
        let temp = tempfile::tempdir().unwrap();
        let sources = Sources {
            crash_report: Some(br#"{"crashType":"panic","path":"/home/anna/x"}"#.to_vec()),
            ..sources(temp.path())
        };
        fs::create_dir_all(&sources.logs_dir).unwrap();
        fs::create_dir_all(&sources.updater_dir).unwrap();
        fs::write(sources.logs_dir.join("protocol_r2026-11-25_09-00-00.log"), "older launch").unwrap();
        fs::write(
            sources.logs_dir.join("protocol_r2026-11-26_09-00-00.log"),
            "model at /home/anna/.local/share/x for anna",
        )
        .unwrap();
        fs::write(sources.logs_dir.join("notes.txt"), "not a log").unwrap();
        fs::write(&sources.errors_file, "[flexi_logger] write failed").unwrap();
        fs::write(sources.updater_dir.join("updater.log"), "check started").unwrap();
        fs::write(sources.updater_dir.join("cache.bin"), "not a log").unwrap();
        let destination = temp.path().join("Protocol-logs.zip");

        let count = write_bundle(&destination, &sources, &Identity::new(Some("/home/anna"), Some("anna"))).unwrap();

        let files = read_zip(&destination);
        let zipped: Vec<&str> = files.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(count, zipped.len());
        assert_eq!(
            zipped,
            [
                "README.txt",
                "system.txt",
                "logs/protocol_r2026-11-25_09-00-00.log",
                "logs/protocol_r2026-11-26_09-00-00.log",
                "logs/log-errors.txt",
                "updater/updater.log",
                "crash-report.json",
            ]
        );
        let text = |name: &str| files.iter().find(|(file, _)| file == name).unwrap().1.clone();
        assert_eq!(text("logs/protocol_r2026-11-26_09-00-00.log"), "model at ~/.local/share/x for <user>");
        assert_eq!(text("crash-report.json"), r#"{"crashType":"panic","path":"~/x"}"#);
        assert!(text("README.txt").contains("What the log can hold"));
    }

    #[test]
    fn missing_folders_still_make_a_zip() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("logs.ZIP");
        let count = write_bundle(&destination, &sources(temp.path()), &Identity::new(None, None)).unwrap();
        assert_eq!(count, 2);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_is_left_out_and_named() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let sources = sources(temp.path());
        fs::create_dir_all(&sources.logs_dir).unwrap();
        let locked = sources.logs_dir.join("protocol_r2026-11-26_09-00-00.log");
        fs::write(&locked, "secret").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads anything; the check means nothing there.
        if fs::read(&locked).is_ok() {
            return;
        }
        let destination = temp.path().join("logs.zip");
        write_bundle(&destination, &sources, &Identity::new(None, None)).unwrap();
        let files = read_zip(&destination);
        let names: Vec<&str> = files.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["README.txt", "system.txt", "unreadable.txt"]);
        assert!(files[2].1.contains("logs/protocol_r2026-11-26_09-00-00.log: "), "{}", files[2].1);
    }

    #[test]
    fn only_a_zip_in_an_existing_folder_is_written() {
        let temp = tempfile::tempdir().unwrap();
        let sources = sources(temp.path());
        let identity = Identity::new(None, None);
        assert!(write_bundle(&temp.path().join("logs"), &sources, &identity).is_err());
        assert!(write_bundle(&temp.path().join("absent/logs.zip"), &sources, &identity).is_err());
    }
}
