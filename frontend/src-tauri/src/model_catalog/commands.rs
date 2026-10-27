//! Tauri commands of the model catalog. Each returns the resulting status;
//! changes are also pushed as `model-catalog-changed`.

use super::schema::Engine;
use super::service::{self, CatalogState, Status};
use tauri::{AppHandle, Manager, Runtime};

#[tauri::command]
pub async fn model_catalog_get_status<R: Runtime>(app: AppHandle<R>) -> Result<Status, String> {
    app.try_state::<CatalogState>()
        .map(|state| state.status())
        .ok_or_else(|| "The model list is still loading".to_string())
}

/// Check for model updates (Settings): fetches the catalog from `main` and
/// compares the installed models with Hugging Face now.
#[tauri::command]
pub async fn model_catalog_check_now<R: Runtime>(app: AppHandle<R>) -> Result<Status, String> {
    service::check(&app, true).await
}

/// Starts the update a model's card offers; progress follows as events.
#[tauri::command]
pub async fn model_update_start<R: Runtime>(app: AppHandle<R>, engine: Engine, id: String) -> Result<Status, String> {
    service::start_update(&app, engine, &id)
}

/// A model list of `engine` (or a line naming the models `ids`) is on screen:
/// reads the sizes it lacks from Hugging Face in the background;
/// `model-catalog-changed` follows.
#[tauri::command]
pub async fn model_catalog_request_sizes<R: Runtime>(
    app: AppHandle<R>,
    engine: Engine,
    ids: Option<Vec<String>>,
) -> Result<(), String> {
    service::request_sizes(&app, engine, ids);
    Ok(())
}

/// The size of one model for display, in bytes; `null` while unknown.
#[tauri::command]
pub async fn model_catalog_model_size(engine: Engine, id: String) -> Result<Option<u64>, String> {
    Ok(service::model_size(engine, &id))
}

#[tauri::command]
pub async fn model_update_cancel<R: Runtime>(app: AppHandle<R>, engine: Engine, id: String) -> Result<Status, String> {
    service::cancel_update(&app, engine, &id)
}
