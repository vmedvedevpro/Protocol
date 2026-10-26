//! Tauri commands of the updater. Each returns the resulting snapshot; the
//! same snapshot is also pushed as `updater-status` to every window.

use super::busy::{self, UiActivity};
use super::{install, Snapshot, UpdaterState};
use tauri::{AppHandle, Manager, Runtime};

const STARTING: &str = "The updater is still starting";

fn ready<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.try_state::<UpdaterState>().map(|_| ()).ok_or_else(|| STARTING.to_string())
}

#[tauri::command]
pub async fn updater_get_status<R: Runtime>(app: AppHandle<R>) -> Result<Snapshot, String> {
    ready(&app)?;
    super::refresh_onboarding(&app).await;
    Ok(app.state::<UpdaterState>().snapshot())
}

#[tauri::command]
pub async fn updater_check_now<R: Runtime>(app: AppHandle<R>) -> Result<Snapshot, String> {
    ready(&app)?;
    Ok(super::check_now(&app, true).await)
}

#[tauri::command]
pub async fn updater_download_now<R: Runtime>(app: AppHandle<R>) -> Result<Snapshot, String> {
    ready(&app)?;
    Ok(super::request_download(&app))
}

/// "Restart and update". `Err` carries why it was refused (`busy` with the
/// reasons, or `notReady`); an install that failed returns the snapshot with
/// its error.
#[tauri::command]
pub async fn updater_install_now<R: Runtime>(app: AppHandle<R>) -> Result<Snapshot, install::Refusal> {
    if app.try_state::<UpdaterState>().is_none() {
        return Err(install::Refusal::NotReady);
    }
    match super::install_and_restart(&app).await {
        Ok(()) | Err(install::Refusal::Failed) => Ok(app.state::<UpdaterState>().snapshot()),
        Err(refusal) => Err(refusal),
    }
}

#[tauri::command]
pub async fn updater_set_auto_check<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<Snapshot, String> {
    ready(&app)?;
    Ok(super::set_auto_check(&app, enabled))
}

/// The frontend's whole current activity set (see `busy.rs`).
#[tauri::command]
pub fn updater_set_ui_activity(activities: Vec<UiActivity>) {
    busy::set_ui_activity(activities);
}
