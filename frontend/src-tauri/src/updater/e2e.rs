//! Unattended update for the end-to-end tests (`updater-e2e` cargo feature,
//! never in release builds). Started with `--updater-e2e-result=<file>`, the
//! app checks, downloads and installs on its own and restarts; the relaunched
//! version writes `{outcome, version, from}` to the file and exits.
//!
//! The flag is a command-line argument, not an environment variable, because
//! the Windows installer relaunches the app through the shell (`/R`), which
//! keeps the arguments (`/ARGS`) but not the environment.

use super::busy::BusyReason;
use super::install::{self, Mode};
use super::status::Activity;
use super::{check_now, request_download, UpdaterState};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Runtime};

const FLAG: &str = "--updater-e2e-result=";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub fn result_path() -> Option<PathBuf> {
    std::env::args().find_map(|arg| arg.strip_prefix(FLAG).map(PathBuf::from))
}

/// Runs instead of the scheduler, after the launch-time restore.
pub async fn run<R: Runtime>(app: &AppHandle<R>, result: &Path) {
    let state = app.state::<UpdaterState>();
    let current = state.current_version.clone();
    let updated_from = state.updated_from.lock().ok().and_then(|from| from.clone());
    if let Some(from) = updated_from {
        finish(app, result, json!({ "outcome": "updated", "version": current, "from": from }), 0);
        return;
    }

    let snapshot = check_now(app, true).await;
    if snapshot.offer.is_none() {
        let detail = json!({ "outcome": "noUpdate", "version": current, "support": snapshot.support, "error": snapshot.error });
        finish(app, result, detail, 1);
        return;
    }
    request_download(app);
    let started = Instant::now();
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let snapshot = state.snapshot();
        if snapshot.offer.as_ref().is_some_and(|offer| offer.downloaded) {
            break;
        }
        let failed = snapshot.activity == Activity::Idle && snapshot.error.is_some();
        if failed || started.elapsed() > DOWNLOAD_TIMEOUT {
            finish(app, result, json!({ "outcome": "downloadFailed", "version": current, "error": snapshot.error }), 1);
            return;
        }
    }

    // A fresh profile never finishes onboarding; nothing else is exempt.
    if let Err(refusal) = install::install_now(app, Mode::Restart, &[BusyReason::Onboarding]).await {
        let snapshot = state.snapshot();
        let detail = json!({ "outcome": "installRefused", "version": current, "refusal": refusal, "error": snapshot.error });
        finish(app, result, detail, 1);
    }
}

fn finish<R: Runtime>(app: &AppHandle<R>, result: &Path, detail: serde_json::Value, code: i32) {
    log::info!("[updater] e2e result: {detail}");
    let partial = result.with_extension("partial");
    let written = std::fs::write(&partial, detail.to_string()).and_then(|()| std::fs::rename(&partial, result));
    if let Err(error) = written {
        log::error!("[updater] could not write the e2e result to {}: {error}", result.display());
    }
    app.exit(code);
}
