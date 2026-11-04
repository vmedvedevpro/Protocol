//! The speech models Protocol picks for this computer (#88), native half.
//!
//! The recommendation itself lives in the WebView (`lib/speech-choice.ts`):
//! it only decides what Settings and onboarding show and what a click
//! downloads. What has to outlive the WebView is here:
//!
//! - **The Intel GPU version of Whisper is a model of its own.** Its id is
//!   its catalog entry's (`large-v3-turbo-openvino-int8`), saved as any
//!   Whisper model is (`whisper:<id>` after meetings, `localWhisper:<id>`
//!   live), and listed by `discover_models` beside the ggml models with
//!   [`ModelInfo::companion_of`] set. Loading it runs OpenVINO (#79); when
//!   OpenVINO does not take it (not installed, Intel's libraries gone or
//!   refused, a failed compile) a regular copy from `companion_of` runs on
//!   whisper.cpp instead ([`regular_copy`]), and without one the load fails
//!   with [`no_copy_message`]. An explicitly chosen ggml model keeps #79's
//!   behaviour: its companion, when installed, runs in its place.
//! - **Choosing it** (`openvino_download` with `choose`, from the card, the
//!   update offer or onboarding) makes it the after-meeting model when the
//!   download ends, in native code ([`chosen`]), so a WebView reload cannot
//!   lose the choice.
//! - **The Compressed copy retires** once the Intel GPU version has finished
//!   a post-meeting pass (a retranscription or an import) on OpenVINO, if
//!   the copy was installed when the person chose the Intel GPU version and
//!   nothing else uses it ([`retires_copy`]). [`CHOSEN_MARKER`] in the
//!   companion's folder records the first condition; it is written only when
//!   the copy was on disk then, so a copy downloaded later (the card offers
//!   one after a failure) is never removed, and the rule fires once.

use std::path::PathBuf;

use anyhow::{anyhow, Result};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::database::repositories::setting::SettingsRepository;
use crate::model_catalog::schema::{Engine, Entry};
use crate::model_catalog::{self, installed, sizes};
use crate::whisper_engine::{ModelInfo, ModelStatus};

/// The regular copy the Intel GPU version replaces: Large V3 Turbo
/// Compressed, the model the update from 0.4.x has.
pub const COMPRESSED_COPY: &str = crate::optional_models::WHISPER_MODEL;

/// Left in the companion's folder by a download with `choose` while the
/// Compressed copy was installed: the copy may go once the Intel GPU version
/// has transcribed a meeting. Removed with the companion's folder.
pub const CHOSEN_MARKER: &str = ".replaces-compressed";

/// The catalog entry of the Intel GPU version `id`, if `id` names one.
pub fn gpu_version(id: &str) -> Option<Entry> {
    model_catalog::companions().into_iter().find(|entry| entry.id == id)
}

#[cfg(windows)]
fn companion_dir(entry: &Entry) -> PathBuf {
    model_catalog::openvino::dir_in(&crate::paths::models_dir(), entry)
}

/// The installed companion `entry`, verified, or `None`.
#[cfg(windows)]
pub fn installed(entry: &Entry) -> Option<model_catalog::openvino::InstalledCompanion> {
    let first = entry.companion_of.first()?;
    model_catalog::openvino::installed_companion(first).filter(|companion| companion.dir == companion_dir(entry))
}

/// The regular copy a load of `version` falls back to: of the ggml models it
/// serves that `is_installed`, the one the catalog recommends, else the first.
pub fn regular_copy(version: &Entry, is_installed: impl Fn(&str) -> bool) -> Option<String> {
    let installed: Vec<&str> = version.companion_of.iter().map(String::as_str).filter(|id| is_installed(id)).collect();
    let recommended = installed
        .iter()
        .copied()
        .find(|id| model_catalog::entry(Engine::Whisper, id).is_some_and(|entry| entry.recommended));
    recommended.or_else(|| installed.first().copied()).map(str::to_string)
}

/// What a load of the Intel GPU version says when OpenVINO did not take it
/// (`reason`) and no regular copy is installed. Settings offers the standard
/// version beside it.
pub fn no_copy_message(reason: &str) -> String {
    format!(
        "The Intel GPU version of Whisper didn't start ({reason}), and no regular copy of the model is installed. \
         Download the standard version in Settings › Transcription."
    )
}

/// The rows `discover_models` adds for the Intel GPU versions: Available once
/// the companion is installed, else Missing (a saved choice of it still loads
/// a regular copy). Named after the model they serve ("Large V3 Turbo"); the
/// UI adds the "Intel GPU" badge.
#[cfg(windows)]
pub fn listed() -> Vec<ModelInfo> {
    model_catalog::companions()
        .into_iter()
        .filter_map(|entry| {
            let serves = model_catalog::entry(Engine::Whisper, entry.companion_of.first()?)?;
            let companion = installed(&entry);
            let size_bytes = match &companion {
                Some(companion) => installed::expected(&entry, &installed::record_path_for_dir(&companion.dir))
                    .map(|expected| expected.total_size()),
                None => sizes::download_size(&entry),
            };
            Some(ModelInfo {
                name: entry.id.clone(),
                path: companion_dir(&entry),
                size_bytes,
                accuracy: serves.accuracy.clone().unwrap_or_default(),
                speed: serves.speed.clone().unwrap_or_default(),
                status: if companion.is_some() { ModelStatus::Available } else { ModelStatus::Missing },
                description: entry.description.clone(),
                display_name: serves.name.clone(),
                tier: None,
                recommended: false,
                languages: entry.languages.clone(),
                companion_of: entry.companion_of.clone(),
            })
        })
        .collect()
}

#[cfg(not(windows))]
pub fn listed() -> Vec<ModelInfo> {
    Vec::new()
}

#[cfg(windows)]
async fn whisper_installed(id: &str) -> bool {
    crate::whisper_engine::commands::whisper_get_available_models()
        .await
        .map(|models| models.iter().any(|model| model.name == id && matches!(model.status, ModelStatus::Available)))
        .unwrap_or(false)
}

/// After `openvino_download` with `choose` installed the companion `entry`:
/// makes it the after-meeting model and, when the Compressed copy is on disk,
/// leaves [`CHOSEN_MARKER`] so the copy retires after the first pass.
#[cfg(windows)]
pub async fn chosen<R: Runtime>(app: &AppHandle<R>, entry: &Entry) -> Result<(), String> {
    let state = app.state::<crate::state::AppState>();
    SettingsRepository::save_post_call_transcript_config(state.db_manager.pool(), "whisper", &entry.id)
        .await
        .map_err(|error| format!("The Intel GPU version is installed, but Protocol could not use it after meetings: {error}"))?;
    let _ = app.emit("post-call-transcript-config-changed", ());
    if entry.companion_of.iter().any(|id| id == COMPRESSED_COPY) && whisper_installed(COMPRESSED_COPY).await {
        let marker = companion_dir(entry).join(CHOSEN_MARKER);
        if let Err(error) = std::fs::write(&marker, COMPRESSED_COPY) {
            // The copy then stays; nothing else depends on the marker.
            log::warn!("[speech-choice] could not write {}: {error}", marker.display());
        }
    }
    log::info!("[speech-choice] {} is the after-meeting model", entry.id);
    Ok(())
}

/// What decides whether the Compressed copy retires after a pass.
#[derive(Debug, Clone, Default)]
pub struct CopyUse<'a> {
    /// [`CHOSEN_MARKER`] is in the companion's folder.
    pub chosen: bool,
    pub copy_installed: bool,
    /// The pass ran on OpenVINO.
    pub ran_on_gpu: bool,
    pub recording: bool,
    /// The live provider and model (`localWhisper`/`parakeet`/…).
    pub live: (&'a str, &'a str),
    /// The after-meeting provider and model (`live`/`whisper`/`parakeet`).
    pub post_call: (&'a str, &'a str),
    /// The model the Whisper engine holds now.
    pub loaded: Option<&'a str>,
}

/// Whether `copy` retires: chosen through the card or the offer, proved by a
/// pass on the Intel GPU, and used nowhere — neither live nor after meetings
/// (also not through "Same as during the meeting"), not loaded, and no
/// recording running that could load it.
pub fn retires_copy(copy: &str, facts: &CopyUse) -> bool {
    let live_uses = matches!(facts.live.0, "localWhisper" | "whisper") && facts.live.1 == copy;
    let post_call_uses = facts.post_call.0 == "whisper" && facts.post_call.1 == copy;
    facts.chosen
        && facts.copy_installed
        && facts.ran_on_gpu
        && !facts.recording
        && !live_uses
        && !post_call_uses
        && facts.loaded != Some(copy)
}

/// Whether the Whisper engine runs on OpenVINO now: asked at the end of a
/// post-meeting pass, before the batch unload.
pub async fn runs_on_gpu() -> bool {
    #[cfg(windows)]
    {
        let engine = crate::whisper_engine::commands::WHISPER_ENGINE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .cloned();
        if let Some(engine) = engine {
            return engine.loaded_openvino().is_some();
        }
    }
    false
}

/// Called when a retranscription or an import succeeded; `ran_on_gpu` is
/// [`runs_on_gpu`] at its end. The check and the removal run on their own
/// task, after the pass has released the engine.
pub fn after_post_meeting_pass<R: Runtime>(app: AppHandle<R>, ran_on_gpu: bool) {
    #[cfg(not(windows))]
    let _ = (app, ran_on_gpu);
    #[cfg(windows)]
    if ran_on_gpu {
            tauri::async_runtime::spawn(async move {
            match retire_copy(&app).await {
                Ok(true) => log::info!("[speech-choice] removed {COMPRESSED_COPY}: the Intel GPU version transcribed a meeting"),
                Ok(false) => {}
            Err(error) => log::warn!("[speech-choice] could not remove {COMPRESSED_COPY}: {error:#}"),
            }
        });
    }
}

/// For Settings: whether the Compressed copy waits to retire after the
/// Intel GPU version's first meeting ([`CHOSEN_MARKER`]).
#[cfg(windows)]
#[tauri::command]
pub fn speech_choice_copy_retires() -> bool {
    !chosen_markers().is_empty()
}

#[cfg(windows)]
fn chosen_markers() -> Vec<PathBuf> {
    model_catalog::companions()
        .iter()
        .filter(|entry| entry.companion_of.iter().any(|id| id == COMPRESSED_COPY))
        .map(|entry| companion_dir(entry).join(CHOSEN_MARKER))
        .filter(|marker| marker.is_file())
        .collect()
}

#[cfg(windows)]
async fn retire_copy<R: Runtime>(app: &AppHandle<R>) -> Result<bool> {
    let markers = chosen_markers();
    if markers.is_empty() {
        return Ok(false);
    }
    // A download, an activation or an uninstall of the copy is running:
    // the next pass decides again.
    let Ok(_operation) = crate::optional_models::operation("whisper") else {
        return Ok(false);
    };
    let _engines = crate::audio::common::acquire_engine_lifecycle_lock().await;
    let engine = crate::whisper_engine::commands::WHISPER_ENGINE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .cloned()
        .ok_or_else(|| anyhow!("the Whisper engine is not initialized"))?;
    let models = engine.discover_models().await?;
    let copy_installed = models.iter().any(|model| model.name == COMPRESSED_COPY && matches!(model.status, ModelStatus::Available));
    let pool = app.state::<crate::state::AppState>().db_manager.pool().clone();
    let live = SettingsRepository::get_transcript_config(&pool).await?;
    let post_call = SettingsRepository::get_post_call_transcript_config(&pool).await?.unwrap_or_else(|| ("live".into(), String::new()));
    let loaded = engine.get_current_model().await;
    let facts = CopyUse {
        chosen: true,
        copy_installed,
        ran_on_gpu: true,
        recording: crate::audio::recording_commands::is_recording().await,
        live: live.as_ref().map_or(("", ""), |live| (live.provider.as_str(), live.model.as_str())),
        post_call: (post_call.0.as_str(), post_call.1.as_str()),
        loaded: loaded.as_deref(),
    };
    if !retires_copy(COMPRESSED_COPY, &facts) {
        // Still chosen: a later pass may find the copy unused.
        return Ok(false);
    }
    engine.delete_model(COMPRESSED_COPY).await?;
    for marker in markers {
        let _ = std::fs::remove_file(marker);
    }
    // The optional Whisper job and the model lists refresh on this event.
    let _ = app.emit("optional-model-removed", "whisper");
    Ok(true)
}

/// Removes the Intel GPU version `id` from the card: first moves every
/// choice of it to a regular copy (after meetings: the copy, else "Same as
/// during the meeting"; live: the copy, else Parakeet), as removing a ggml
/// model does, then `openvino_remove`.
#[cfg(windows)]
#[tauri::command]
pub async fn speech_choice_remove_gpu_version<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let entry = gpu_version(&id).ok_or_else(|| format!("{id} is not in the model list"))?;
    let models = crate::whisper_engine::commands::whisper_get_available_models().await?;
    let copy = regular_copy(&entry, |name| {
        models.iter().any(|model| model.name == name && matches!(model.status, ModelStatus::Available))
    });
    let pool = app.state::<crate::state::AppState>().db_manager.pool().clone();
    move_choices(&pool, &id, copy.as_deref()).await.map_err(|error| error.to_string())?;
    let _ = app.emit("transcript-config-changed", ());
    let _ = app.emit("post-call-transcript-config-changed", ());
    model_catalog::openvino::openvino_remove(app, id).await
}

#[cfg(windows)]
async fn move_choices(pool: &sqlx::SqlitePool, id: &str, copy: Option<&str>) -> std::result::Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    let (post_provider, post_model) = copy.map_or(("live", ""), |copy| ("whisper", copy));
    sqlx::query("UPDATE transcript_settings SET postCallProvider = ?, postCallModel = ? WHERE postCallProvider = 'whisper' AND postCallModel = ?")
        .bind(post_provider)
        .bind(post_model)
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    let (live_provider, live_model) = copy.map_or(("parakeet", crate::config::DEFAULT_PARAKEET_MODEL), |copy| ("localWhisper", copy));
    sqlx::query("UPDATE transcript_settings SET provider = ?, model = ? WHERE provider IN ('localWhisper', 'whisper') AND model = ?")
        .bind(live_provider)
        .bind(live_model)
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    const COPY: &str = "large-v3-turbo-q5_0";
    const GPU: &str = "large-v3-turbo-openvino-int8";

    fn proved<'a>() -> CopyUse<'a> {
        CopyUse {
            chosen: true,
            copy_installed: true,
            ran_on_gpu: true,
            recording: false,
            live: ("parakeet", "parakeet-tdt-0.6b-v3-int8"),
            post_call: ("whisper", GPU),
            loaded: None,
        }
    }

    #[test]
    fn the_copy_retires_after_a_pass_on_the_gpu_when_nothing_uses_it() {
        assert!(retires_copy(COPY, &proved()));
    }

    #[test]
    fn the_copy_stays_unless_every_condition_holds() {
        let stays = |facts: CopyUse| assert!(!retires_copy(COPY, &facts), "{facts:?}");
        stays(CopyUse { chosen: false, ..proved() });
        stays(CopyUse { copy_installed: false, ..proved() });
        stays(CopyUse { ran_on_gpu: false, ..proved() });
        stays(CopyUse { recording: true, ..proved() });
        stays(CopyUse { loaded: Some(COPY), ..proved() });
        // Used live (both spellings of the Whisper provider)…
        stays(CopyUse { live: ("localWhisper", COPY), ..proved() });
        stays(CopyUse { live: ("whisper", COPY), ..proved() });
        // …through "Same as during the meeting", or after meetings.
        stays(CopyUse { live: ("localWhisper", COPY), post_call: ("live", ""), ..proved() });
        stays(CopyUse { post_call: ("whisper", COPY), ..proved() });
    }

    #[test]
    fn another_model_of_the_same_name_elsewhere_does_not_keep_the_copy() {
        // Parakeet live, another Whisper after meetings: the copy is unused.
        assert!(retires_copy(COPY, &CopyUse { post_call: ("whisper", "small"), ..proved() }));
        assert!(retires_copy(COPY, &CopyUse { live: ("parakeet", COPY), ..proved() }));
    }

    fn version() -> Entry {
        model_catalog::companions().into_iter().find(|entry| entry.id == GPU).expect("the built-in catalog has the Intel GPU version")
    }

    #[test]
    fn the_intel_gpu_version_is_found_by_its_id_only() {
        assert_eq!(gpu_version(GPU).map(|entry| entry.id), Some(GPU.to_string()));
        assert!(gpu_version(COPY).is_none());
        assert!(gpu_version("small").is_none());
    }

    #[test]
    fn a_failed_gpu_version_falls_back_to_an_installed_regular_copy() {
        let version = version();
        // The recommended Compressed copy wins over the full model.
        assert_eq!(regular_copy(&version, |id| id == COPY || id == "large-v3-turbo").as_deref(), Some(COPY));
        assert_eq!(regular_copy(&version, |id| id == "large-v3-turbo").as_deref(), Some("large-v3-turbo"));
        // A model it does not serve is no copy of it.
        assert_eq!(regular_copy(&version, |id| id == "small"), None);
        assert_eq!(regular_copy(&version, |_| false), None);
    }

    #[test]
    fn without_a_copy_the_message_says_why_and_what_to_do() {
        let message = no_copy_message("the Intel GPU version is not installed");
        assert!(message.contains("the Intel GPU version is not installed"));
        assert!(message.contains("Download the standard version"));
        assert!(!message.contains("OpenVINO"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn removing_the_gpu_version_moves_its_choices_to_the_copy_or_the_defaults() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE transcript_settings (provider TEXT, model TEXT, postCallProvider TEXT, postCallModel TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        let row = || async {
            sqlx::query_as::<_, (String, String, String, String)>("SELECT * FROM transcript_settings").fetch_one(&pool).await.unwrap()
        };
        sqlx::query("INSERT INTO transcript_settings VALUES ('localWhisper', ?, 'whisper', ?)").bind(GPU).bind(GPU).execute(&pool).await.unwrap();
        move_choices(&pool, GPU, Some(COPY)).await.unwrap();
        assert_eq!(row().await, ("localWhisper".into(), COPY.into(), "whisper".into(), COPY.into()));

        sqlx::query("UPDATE transcript_settings SET provider = 'localWhisper', model = ?, postCallProvider = 'whisper', postCallModel = ?")
            .bind(GPU)
            .bind(GPU)
            .execute(&pool)
            .await
            .unwrap();
        move_choices(&pool, GPU, None).await.unwrap();
        assert_eq!(row().await, ("parakeet".into(), crate::config::DEFAULT_PARAKEET_MODEL.into(), "live".into(), "".into()));

        // Choices of other models are left alone.
        sqlx::query("UPDATE transcript_settings SET provider = 'parakeet', model = 'p', postCallProvider = 'whisper', postCallModel = 'small'")
            .execute(&pool)
            .await
            .unwrap();
        move_choices(&pool, GPU, Some(COPY)).await.unwrap();
        assert_eq!(row().await, ("parakeet".into(), "p".into(), "whisper".into(), "small".into()));
    }
}
