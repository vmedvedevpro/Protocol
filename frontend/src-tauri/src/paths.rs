//! Platform-safe local path resolution.
//!
//! Windows prefers a self-contained `data` directory beside the executable.
//! macOS always uses `~/Library/Application Support/vmedvedevpro/Protocol`
//! because its executable lives inside the signed app bundle; writing runtime
//! data there invalidates the bundle signature.
//!
//! On Windows and Linux, data goes under `<exe_dir>/data` when that folder is
//! writable. If it is not (`C:\Program Files`, the deb's `/usr/bin`, a FUSE
//! mounted AppImage), storage falls back to the OS data directory.
//!
//! Linux ships no portable build: the deb and the AppImage both keep data in
//! the XDG data folder. The `data` folder beside the executable stays on Linux
//! for development builds, which run from a writable `target/` folder: there it
//! keeps a branch's database, with migrations that were never released, out of
//! the installed app's library, which would then refuse to open it. An
//! AppImage never uses it, even when its executable folder is writable: with
//! `APPIMAGE_EXTRACT_AND_RUN=1` (no FUSE) the executable runs from a
//! `/tmp/appimage_extracted_<hash>` folder that a reboot may clear and that
//! the next AppImage version replaces (#230). A library such a run left
//! there is not moved: only testers ran those AppImages.

use std::path::PathBuf;
use std::sync::OnceLock;

/// The subfolder (relative to the executable) that holds portable app data.
#[cfg(not(target_os = "macos"))]
const DATA_SUBDIR: &str = "data";
/// Folders used under the OS data directory: `<publisher>/<product>`, as in the
/// Windows install folder, so the generic product name cannot collide with
/// another app's folder.
const FALLBACK_PUBLISHER: &str = "vmedvedevpro";
const FALLBACK_APP_NAME: &str = "Protocol";

/// The data root and how it was chosen.
static ROOT: OnceLock<(PathBuf, String)> = OnceLock::new();

/// Returns the app-managed data root, creating it if needed. Resolved once and
/// cached for the lifetime of the process.
///
/// This is the single source of truth that replaces every previous use of
/// Tauri's `app_data_dir()` and `dirs::data_dir()` for app-managed storage.
pub fn install_data_root() -> PathBuf {
    resolved_root().0.clone()
}

/// How the data root was chosen, for the log's first line: the root is
/// resolved before the logger starts, so it cannot log this itself.
pub fn data_root_origin() -> &'static str {
    &resolved_root().1
}

fn resolved_root() -> &'static (PathBuf, String) {
    ROOT.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            (os_data_root(), "the macOS data folder".to_string())
        }

        #[cfg(not(target_os = "macos"))]
        {
            let exe = std::env::current_exe().ok();
            // The AppImage runtime sets APPDIR in both FUSE and extract-and-run
            // mode. Only Linux has AppImages; elsewhere the variable means
            // nothing to Protocol.
            #[cfg(target_os = "linux")]
            let appdir = std::env::var_os("APPDIR")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from);
            #[cfg(not(target_os = "linux"))]
            let appdir: Option<PathBuf> = None;
            match choose_root(exe.as_deref(), appdir.as_deref(), ensure_writable) {
                RootChoice::Portable(dir) => (dir, "portable, beside the executable".to_string()),
                RootChoice::Os(origin) => (os_data_root(), origin),
            }
        }
    })
}

#[cfg(not(target_os = "macos"))]
#[derive(Debug, PartialEq)]
enum RootChoice {
    /// `<exe_dir>/data`, which `writable` has created.
    Portable(PathBuf),
    /// The OS data folder, with the reason the log's first line gives.
    Os(String),
}

/// Where the data root goes for the executable `exe`, given the AppImage
/// runtime's `APPDIR`. `writable` creates and probes the portable folder.
#[cfg(not(target_os = "macos"))]
fn choose_root(
    exe: Option<&std::path::Path>,
    appdir: Option<&std::path::Path>,
    writable: impl Fn(&std::path::Path) -> bool,
) -> RootChoice {
    let Some(exe_dir) = exe.and_then(|exe| exe.parent()) else {
        return RootChoice::Os("the OS data folder".to_string());
    };
    if appdir.is_some_and(|appdir| inside(exe_dir, appdir)) {
        return RootChoice::Os("the OS data folder, since Protocol runs from an AppImage".to_string());
    }
    let candidate = exe_dir.join(DATA_SUBDIR);
    if writable(&candidate) {
        return RootChoice::Portable(candidate);
    }
    RootChoice::Os(format!("the OS data folder, since {} is not writable", candidate.display()))
}

/// Whether `path` lies inside `dir`. An AppImage's child processes inherit
/// APPDIR, so a variable that names some other folder, as in a development
/// build started from a terminal an AppImage app opened, does not make this
/// executable an AppImage's.
#[cfg(not(target_os = "macos"))]
fn inside(path: &std::path::Path, dir: &std::path::Path) -> bool {
    let canonical = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canonical(path).starts_with(canonical(dir))
}

fn os_data_root() -> PathBuf {
    let root = dirs::data_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(FALLBACK_PUBLISHER)
        .join(FALLBACK_APP_NAME);
    let _ = std::fs::create_dir_all(&root);
    root
}

/// Opens `target` with the system: a folder in the file manager, a link in
/// the browser (`open` and `xdg-open` take a URL as they take a path; Windows
/// opens links through `ShellExecuteW` in `open_external_url`). With `select`,
/// a file is shown selected in Explorer and Finder; Linux has no common way to
/// select one, so its folder opens.
pub fn open_in_system(target: &std::ffi::OsStr, select: bool) -> std::io::Result<()> {
    use std::process::Command;
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("explorer.exe");
        if select {
            // raw_arg: Explorer reads /select,"path" and not a quoted whole.
            let mut argument = std::ffi::OsString::from("/select,\"");
            argument.push(target);
            argument.push("\"");
            command.raw_arg(argument);
        } else {
            command.arg(target);
        }
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        if select {
            command.arg("-R");
        }
        command.arg(target);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        let folder = std::path::Path::new(target).parent().unwrap_or(std::path::Path::new("."));
        command.arg(if select { folder.as_os_str() } else { target });
        command
    };
    let mut child = command.spawn()?;
    // Reaped on a thread of its own, so the launcher does not stay behind as
    // a zombie while the app runs.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Directory that holds all downloaded speech/LLM models
/// (`<root>/models`). Mirrors the previous `app_data_dir/models` layout.
pub fn models_dir() -> PathBuf {
    let dir = install_data_root().join("models");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// One-time, non-destructive migration of a previous (scattered) install.
///
/// Earlier builds stored data under the OS application-data directory
/// (`%APPDATA%\<id>` / `~/Library/Application Support/<id>`). To honor the
/// current layout without forcing users to re-download gigabytes of models or
/// lose meeting history, on first run we COPY the known legacy items into the
/// current data root. The original files are left
/// untouched (users can delete the old folder afterward). Guarded by a marker
/// file so it only ever runs once, and best-effort so it can never break start.
pub fn migrate_legacy_data<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;

    let root = install_data_root();
    let marker = root.join(".migrated_from_appdata");
    if marker.exists() {
        return;
    }

    // The legacy OS app-data directory (what old builds used).
    let legacy = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(_) => {
            let _ = std::fs::write(&marker, b"no-legacy");
            return;
        }
    };

    if legacy == root || !legacy.exists() {
        let _ = std::fs::write(&marker, b"no-legacy");
        return;
    }

    log::info!(
        "🚚 Portable migration: checking legacy data at {}",
        legacy.display()
    );

    // Known app-managed items. Only copied when missing locally, so re-running
    // (marker deleted) never clobbers newer local data.
    const ITEMS: [&str; 5] = [
        "models",
        "templates",
        "meeting_minutes.sqlite",
        "meeting_minutes.db",
        "recordings",
    ];

    let mut copied_any = false;
    for item in ITEMS {
        let src = legacy.join(item);
        let dst = root.join(item);
        if src.exists() && !dst.exists() {
            log::info!("🚚 Migrating '{}' → {}", item, dst.display());
            match copy_path_recursive(&src, &dst) {
                Ok(_) => copied_any = true,
                Err(e) => log::warn!("Migration of '{}' failed (skipping): {}", item, e),
            }
        }
    }

    if copied_any {
        log::info!("✅ Portable migration complete. You can delete the old folder: {}", legacy.display());
    } else {
        log::info!("Portable migration: nothing to migrate.");
    }

    let _ = std::fs::write(&marker, b"done");
}

/// Recursively copy a file or directory. Best-effort: per-entry failures are
/// propagated so the caller can log, but partial progress is retained.
fn copy_path_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let from = entry.path();
            let to = dst.join(entry.file_name());
            copy_path_recursive(&from, &to)?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

/// Deletes `<root>/claude-cli`, the working folder of the removed Claude Code
/// CLI summary provider (#19). It only ever held `system-prompt-<uuid>.txt`
/// files, which a run that crashed could leave behind. Best effort: a failure
/// is logged and the next start tries again.
pub fn remove_claude_cli_working_dir() {
    remove_retired_dir(&install_data_root().join("claude-cli"));
}

fn remove_retired_dir(dir: &std::path::Path) {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => log::info!("Removed retired folder {}", dir.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("Could not remove retired folder {}: {}", dir.display(), e),
    }
}

/// Ensure `dir` exists and is writable by probing an actual file write.
#[cfg(not(target_os = "macos"))]
fn ensure_writable(dir: &std::path::Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write_test");
    match std::fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod retired_dir_tests {
    use super::remove_retired_dir;

    #[test]
    fn removes_a_retired_folder_and_its_files() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("claude-cli");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("system-prompt-left-by-a-crash.txt"), b"prompt").unwrap();

        remove_retired_dir(&dir);

        assert!(!dir.exists());
        assert!(root.path().exists());
    }

    #[test]
    fn a_missing_folder_is_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        remove_retired_dir(&root.path().join("claude-cli"));
        assert!(root.path().exists());
    }
}

#[cfg(all(test, not(target_os = "macos")))]
mod root_choice_tests {
    use super::{choose_root, RootChoice};

    #[test]
    fn an_appimage_uses_the_os_data_folder_even_when_its_folder_is_writable() {
        // Extract-and-run: the executable sits in a writable temporary folder.
        let appdir = tempfile::tempdir().unwrap();
        let exe = appdir.path().join("usr").join("bin").join("protocol");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();

        let choice = choose_root(Some(&exe), Some(appdir.path()), |_| true);

        assert_eq!(
            choice,
            RootChoice::Os("the OS data folder, since Protocol runs from an AppImage".to_string())
        );
    }

    #[test]
    fn an_inherited_appdir_elsewhere_keeps_the_portable_folder() {
        let appdir = tempfile::tempdir().unwrap();
        let build = tempfile::tempdir().unwrap();
        let exe = build.path().join("protocol");

        let choice = choose_root(Some(&exe), Some(appdir.path()), |_| true);

        assert_eq!(choice, RootChoice::Portable(build.path().join("data")));
    }

    #[test]
    fn a_writable_folder_outside_an_appimage_is_portable() {
        let build = tempfile::tempdir().unwrap();
        let exe = build.path().join("protocol");

        assert_eq!(
            choose_root(Some(&exe), None, |_| true),
            RootChoice::Portable(build.path().join("data"))
        );
    }

    #[test]
    fn a_read_only_install_folder_uses_the_os_data_folder() {
        // The deb's /usr/bin, Windows' Program Files.
        let exe = std::path::Path::new("/usr/bin/protocol");

        let expected = format!(
            "the OS data folder, since {} is not writable",
            exe.parent().unwrap().join("data").display()
        );
        assert_eq!(choose_root(Some(exe), None, |_| false), RootChoice::Os(expected));
    }
}
