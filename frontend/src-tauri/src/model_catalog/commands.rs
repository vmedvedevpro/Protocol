//! Tauri commands of the model catalog. Each returns the resulting status;
//! changes are also pushed as `model-catalog-changed`.

use super::service::{self, CatalogState, Status};
use tauri::{AppHandle, Manager, Runtime};

#[tauri::command]
pub async fn model_catalog_get_status<R: Runtime>(app: AppHandle<R>) -> Result<Status, String> {
    app.try_state::<CatalogState>()
        .map(|state| state.status())
        .ok_or_else(|| "The model list is still loading".to_string())
}

/// Check for model updates (Settings): fetches the catalog from `main` now.
#[tauri::command]
pub async fn model_catalog_check_now<R: Runtime>(app: AppHandle<R>) -> Result<Status, String> {
    service::check(&app, true).await
}
