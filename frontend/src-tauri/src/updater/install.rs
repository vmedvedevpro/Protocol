//! Installing a downloaded update: the gate, the exit preparation and the
//! per-platform install.
//!
//! The gate takes the engine lifecycle lock first. Holding it blocks a
//! recording start (meeting detection can start one at any moment) and batch
//! transcription, so the busy re-check under the lock cannot be overtaken.
//! Import and retranscription set their flags before they wait for that lock,
//! so the re-check sees them too. The lock is kept until the process exits, or
//! released when the install fails.
//!
//! Windows: the plugin writes the NSIS installer to `%TEMP%`, runs it in
//! passive mode with `/UPDATE` (and `/R` to relaunch after a click) and calls
//! `std::process::exit` itself, so `RunEvent::Exit` never runs: the cleanup it
//! would do happens in `prepare_exit` instead. macOS and Linux replace the app
//! in place and then restart or exit normally.

use super::busy::{self, BusyReason};
use super::status::ErrorKind;
use super::{cache::InstallAttempt, emit_status, engine, now_ms, UpdaterState};
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::OwnedMutexGuard;

/// How long the gate waits for the engine lifecycle lock before it reports
/// the speech engine as busy.
const LOCK_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// "Restart and update": install, then start the new version.
    Restart,
    /// Quit: install and exit; nothing starts afterwards.
    Quit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Refusal {
    /// No verified download, or another operation runs.
    NotReady,
    Busy { reasons: Vec<BusyReason> },
    /// The install was attempted and failed; the snapshot carries the error.
    Failed,
}

/// The gate's decision once the lock attempt is over (pure, for tests).
pub(crate) fn evaluate(ready: bool, locked: bool, mut reasons: Vec<BusyReason>, ignore: &[BusyReason]) -> Result<(), Refusal> {
    if !ready {
        return Err(Refusal::NotReady);
    }
    reasons.retain(|reason| !ignore.contains(reason));
    // The lock holder is usually a listed operation (an import holds it while
    // it transcribes), so the user reads that reason first and the engine last.
    if !locked && !reasons.contains(&BusyReason::SpeechEngine) {
        reasons.push(BusyReason::SpeechEngine);
    }
    if reasons.is_empty() {
        Ok(())
    } else {
        Err(Refusal::Busy { reasons })
    }
}

pub(crate) async fn acquire_lock(wait: Duration) -> Option<OwnedMutexGuard<()>> {
    tokio::time::timeout(wait, crate::audio::common::acquire_engine_lifecycle_lock())
        .await
        .ok()
}

/// Installs the downloaded update when nothing is busy. `ignore` exempts
/// reasons for the end-to-end test build only (its fresh profile never
/// finishes onboarding).
pub async fn install_now<R: Runtime>(app: &AppHandle<R>, mode: Mode, ignore: &[BusyReason]) -> Result<(), Refusal> {
    let state = app.state::<UpdaterState>();
    let ready = state.support().installs() && state.ready_version().is_some();
    if !ready {
        return Err(Refusal::NotReady);
    }
    super::refresh_onboarding(app).await;
    let lock = acquire_lock(LOCK_WAIT).await;
    let decision = evaluate(ready, lock.is_some(), busy::current(), ignore);
    if let Err(refusal) = decision {
        state.journal(&format!("install refused: {refusal:?}"));
        return Err(refusal);
    }
    let Some(version) = state.machine().begin_install() else {
        return Err(Refusal::NotReady);
    };
    emit_status(app);

    // Before the payload is read: a quit that skips the install should not
    // hash the whole download first.
    if let Some(problem) = location_problem(mode) {
        if mode == Mode::Quit {
            // Never raise an administrator prompt while the user quits.
            state.journal(&format!("install on quit skipped: {problem}"));
            state.machine().install_skipped();
            emit_status(app);
            return Err(Refusal::NotReady);
        }
        state.journal(&format!("install refused: {problem}"));
        state.machine().install_failed(ErrorKind::Location, problem, now_ms());
        emit_status(app);
        return Err(Refusal::Failed);
    }

    let update =state.pending.lock().ok().and_then(|pending| pending.clone()).filter(|update| update.version == version);
    let entry = state.cache.entries().into_iter().find(|entry| entry.version == version);
    let (Some(update), Some(entry)) = (update, entry) else {
        return fail_before_start(app, ErrorKind::Download, "the downloaded update is missing; download it again".into());
    };
    let cache = super::cache::Cache::new(state.cache.dir().to_path_buf());
    let bytes = match tauri::async_runtime::spawn_blocking(move || cache.read_payload(&entry)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => return fail_before_start(app, ErrorKind::Download, error.to_string()),
        Err(error) => return fail_before_start(app, ErrorKind::Download, error.to_string()),
    };

    prepare_exit(app).await;
    let attempt = InstallAttempt { from: state.current_version.clone(), to: version.clone(), at: now_ms() };
    if let Err(error) = state.cache.write_attempt(&attempt) {
        log::warn!("[updater] could not write the install marker: {error}");
    }
    state.journal(&format!("install {} -> {version} ({mode:?})", state.current_version));

    let result = tauri::async_runtime::spawn_blocking(move || platform_install(update, bytes, mode))
        .await
        .map_err(|error| (ErrorKind::InstallStart, error.to_string()))
        .and_then(|result| result.map_err(|error| (engine::classify(&error, ErrorKind::InstallStart), error.to_string())));

    match result {
        Ok(()) => {
            // Windows never returns here. macOS and Linux replaced the app:
            // keep the lock until the process ends, then restart or exit.
            std::mem::forget(lock);
            state.journal(&format!("installed {version}"));
            match mode {
                Mode::Restart => app.request_restart(),
                Mode::Quit => app.exit(0),
            }
            Ok(())
        }
        Err((kind, message)) => {
            state.journal(&format!("install {version} failed ({kind:?}): {message}"));
            state.cache.clear_attempt();
            resume_after_failed_install();
            if kind == ErrorKind::Signature {
                // The cached payload no longer matches the feed's signature.
                state.cache.remove_except(None);
                state.machine().forget_download();
            }
            state.machine().install_failed(kind, message, now_ms());
            emit_status(app);
            drop(lock);
            Err(Refusal::Failed)
        }
    }
}

fn fail_before_start<R: Runtime>(app: &AppHandle<R>, kind: ErrorKind, message: String) -> Result<(), Refusal> {
    let state = app.state::<UpdaterState>();
    state.journal(&format!("install failed before start: {message}"));
    state.cache.remove_except(None);
    state.machine().forget_download();
    state.machine().install_failed(kind, message, now_ms());
    emit_status(app);
    Err(Refusal::Failed)
}

fn platform_install(update: tauri_plugin_updater::Update, bytes: Vec<u8>, mode: Mode) -> tauri_plugin_updater::Result<()> {
    #[cfg(windows)]
    let update = update.restart_after_install(mode == Mode::Restart);
    #[cfg(not(windows))]
    let _ = mode;
    update.install(bytes)
}

/// What `RunEvent::Exit` would do, kept reversible because the install can
/// still fail: checkpoint the database without closing it, stop llama-helper
/// (it is spawned again on demand, and a running copy would lock its file in
/// the install folder), and close the crash session so the next launch does
/// not report a crash.
async fn prepare_exit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(app_state) = app.try_state::<crate::state::AppState>() {
        if let Err(error) = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(app_state.db_manager.pool())
            .await
        {
            log::warn!("[updater] WAL checkpoint before the update failed: {error}");
        }
    }
    if let Err(error) = crate::summary::summary_engine::force_shutdown_sidecar().await {
        log::warn!("[updater] could not stop the summary sidecar: {error}");
    }
    if let Err(error) = crate::crash_report::finish_session() {
        log::warn!("[updater] could not close the crash session: {error}");
    }
}

fn resume_after_failed_install() {
    if let Err(error) = crate::crash_report::start_session() {
        log::warn!("[updater] could not reopen the crash session: {error}");
    }
}

/// Why the app's files cannot be replaced from here, if they cannot.
fn location_problem(mode: Mode) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().ok()?;
        let bundle = exe.parent()?.parent()?.parent()?.to_path_buf();
        if bundle.to_string_lossy().contains("/AppTranslocation/") {
            return Some("the app runs from a translocated location".into());
        }
        if mode == Mode::Quit && !writable(bundle.parent()?) {
            return Some(format!("{} is not writable", bundle.parent()?.display()));
        }
        None
    }
    #[cfg(target_os = "linux")]
    {
        let appimage = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from)?;
        let folder = appimage.parent()?;
        if !writable(folder) {
            return Some(format!("{} is not writable", folder.display()));
        }
        let _ = mode;
        None
    }
    #[cfg(windows)]
    {
        let _ = mode;
        None
    }
}

#[cfg(unix)]
fn writable(dir: &std::path::Path) -> bool {
    tempfile::Builder::new().prefix(".protocol-update-probe").tempfile_in(dir).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_needs_a_download_the_lock_and_no_work() {
        assert_eq!(evaluate(false, true, vec![], &[]), Err(Refusal::NotReady));
        assert_eq!(
            evaluate(true, false, vec![], &[]),
            Err(Refusal::Busy { reasons: vec![BusyReason::SpeechEngine] })
        );
        // An import holds the engine lock while it transcribes: name it first.
        assert_eq!(
            evaluate(true, false, vec![BusyReason::Import], &[]),
            Err(Refusal::Busy { reasons: vec![BusyReason::Import, BusyReason::SpeechEngine] })
        );
        assert_eq!(
            evaluate(true, true, vec![BusyReason::Import, BusyReason::Summary], &[]),
            Err(Refusal::Busy { reasons: vec![BusyReason::Import, BusyReason::Summary] })
        );
        assert_eq!(evaluate(true, true, vec![], &[]), Ok(()));
    }

    #[test]
    fn only_listed_reasons_are_exempt() {
        assert_eq!(evaluate(true, true, vec![BusyReason::Onboarding], &[BusyReason::Onboarding]), Ok(()));
        assert_eq!(
            evaluate(true, true, vec![BusyReason::Onboarding, BusyReason::Recording], &[BusyReason::Onboarding]),
            Err(Refusal::Busy { reasons: vec![BusyReason::Recording] })
        );
    }

    #[tokio::test]
    async fn the_gate_lock_blocks_a_recording_start_and_times_out_when_taken() {
        let held = acquire_lock(Duration::from_secs(1)).await.expect("free at first");
        // A recording start or batch transcription takes the same lock.
        let start = tokio::time::timeout(
            Duration::from_millis(50),
            crate::audio::common::acquire_engine_lifecycle_lock(),
        )
        .await;
        assert!(start.is_err(), "a recording cannot start while the gate holds the lock");
        assert!(acquire_lock(Duration::from_millis(50)).await.is_none());
        drop(held);
        assert!(acquire_lock(Duration::from_millis(50)).await.is_some());
    }

    #[test]
    fn refusals_serialize_for_the_frontend() {
        let value = serde_json::to_value(Refusal::Busy { reasons: vec![BusyReason::Recording] }).unwrap();
        assert_eq!(value, serde_json::json!({ "kind": "busy", "reasons": ["recording"] }));
    }
}
