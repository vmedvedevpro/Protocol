//! Platform-safe local path resolution.
//!
//! Windows and Linux prefer a self-contained `data` directory beside the
//! executable. macOS always uses
//! `~/Library/Application Support/vmedvedevpro/Protocol` because its executable
//! lives inside the signed app bundle; writing runtime data there invalidates the
//! bundle signature.
//!
//! On portable platforms, everything is placed under `<exe_dir>/data`. If that
//! directory is not writable (for example, under `C:\Program Files`), storage
//! transparently falls back to the OS data directory.

use std::path::{Path, PathBuf};
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
            // Preferred: next to the executable, under `data/`.
            let mut origin = "the OS data folder".to_string();
            if let Some(exe_dir) = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            {
                let candidate = exe_dir.join(DATA_SUBDIR);
                if ensure_writable(&candidate) {
                    return (candidate, "portable, beside the executable".to_string());
                }
                origin = format!("the OS data folder, since {} is not writable", candidate.display());
            }
            (os_data_root(), origin)
        }
    })
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

/// Shows `target` in the file manager: a folder opened, or with `select` a
/// file selected in Explorer and Finder (Linux has no common way to select
/// one, so its folder opens). `open` and `xdg-open` take a URL the same way.
pub fn reveal(target: &Path, select: bool) -> std::io::Result<()> {
    use std::process::Command;
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("explorer.exe");
        if select {
            // raw_arg: Explorer reads /select,"path" and not a quoted whole.
            command.raw_arg(format!("/select,\"{}\"", target.display()));
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
        command.arg(if select { target.parent().unwrap_or(Path::new(".")) } else { target });
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
fn ensure_writable(dir: &PathBuf) -> bool {
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
