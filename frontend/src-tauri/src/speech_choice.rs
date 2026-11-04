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
//!   companion's folder records the first condition. It names the copy's
//!   file as it was then (size and modification time): a copy removed and
//!   downloaded again later (the card offers one after a failure) is another
//!   file, so a marker that outlived its copy never removes another one; the
//!   next pass removes it. It is written whole (renamed into place), removed
//!   before the copy, so the rule fires once, and a crash in between leaves
//!   the copy rather than a marker.

#[cfg(windows)]
use std::path::{Path, PathBuf};

#[cfg(windows)]
use anyhow::{anyhow, Result};
use tauri::{AppHandle, Runtime};
#[cfg(windows)]
use tauri::{Emitter, Manager};

#[cfg(windows)]
use crate::database::repositories::setting::SettingsRepository;
use crate::model_catalog;
use crate::model_catalog::schema::{Engine, Entry};
#[cfg(windows)]
use crate::model_catalog::{installed, sizes};
use crate::whisper_engine::ModelInfo;
#[cfg(windows)]
use crate::whisper_engine::ModelStatus;

/// The regular copy the Intel GPU version replaces: Large V3 Turbo
/// Compressed, the model the update from 0.4.x has.
pub const COMPRESSED_COPY: &str = crate::optional_models::WHISPER_MODEL;

/// Left in the companion's folder by a download with `choose` while the
/// Compressed copy was installed: the copy may go once the Intel GPU version
/// has transcribed a meeting. Holds [`marker_text`] of that copy; removed
/// with the companion's folder, and as soon as it names another file.
pub const CHOSEN_MARKER: &str = ".replaces-compressed";
/// Where [`write_marker`] writes [`CHOSEN_MARKER`] before renaming it into
/// place. Never read: a crash can leave it, and the next write replaces it.
#[cfg(windows)]
const PARTIAL_MARKER: &str = ".replaces-compressed.partial";

/// The file of a copy as a marker names it: its size and modification time.
/// A download writes a new file, so a copy removed and downloaded again has
/// another; a crash or a restore that keeps the old file keeps its name.
#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CopyFile {
    len: u64,
    modified_ns: u128,
}

#[cfg(windows)]
pub(crate) fn copy_file(path: &Path) -> Option<CopyFile> {
    let metadata = std::fs::metadata(path).ok().filter(std::fs::Metadata::is_file)?;
    let modified_ns = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some(CopyFile { len: metadata.len(), modified_ns })
}

/// What [`CHOSEN_MARKER`] holds for the copy `file`.
#[cfg(windows)]
pub(crate) fn marker_text(file: &CopyFile) -> String {
    format!("{COMPRESSED_COPY}\n{}\n{}\n", file.len, file.modified_ns)
}

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

/// The name the person knows the Intel GPU version `version` by: the model
/// it serves and its device ("Large V3 Turbo · Intel GPU").
pub fn version_name(version: &Entry) -> String {
    let serves = version
        .companion_of
        .first()
        .and_then(|id| model_catalog::entry(Engine::Whisper, id))
        .map_or_else(|| version.name.clone(), |entry| entry.name);
    format!("{serves} · Intel GPU")
}

/// `model` as a load error names it: the Intel GPU version by
/// [`version_name`], any other model by its id.
pub fn shown_name(model: &str) -> String {
    gpu_version(model).map_or_else(|| model.to_string(), |version| version_name(&version))
}

/// What a load of the Intel GPU version says when OpenVINO did not take it
/// and no regular copy is installed. The technical reason goes to the log
/// and to Settings' tooltip, not here: it names Intel's libraries by their
/// product name. Settings offers the standard version beside it.
pub fn no_copy_message(version: &Entry) -> String {
    format!(
        "Whisper {} didn't start, and no regular copy of the model is installed. \
         Download the standard version in Settings › Transcription.",
        version_name(version)
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

/// The file of the Compressed copy when the model list has it installed.
#[cfg(windows)]
async fn installed_copy() -> Option<PathBuf> {
    crate::whisper_engine::commands::whisper_get_available_models()
        .await
        .ok()?
        .into_iter()
        .find(|model| model.name == COMPRESSED_COPY && matches!(model.status, ModelStatus::Available))
        .map(|model| model.path)
}

/// After `openvino_download` with `choose` installed the companion `entry`:
/// makes it the after-meeting model and, when the Compressed copy is on disk,
/// leaves [`CHOSEN_MARKER`] naming it so it retires after the first pass.
#[cfg(windows)]
pub async fn chosen<R: Runtime>(app: &AppHandle<R>, entry: &Entry) -> Result<(), String> {
    let state = app.state::<crate::state::AppState>();
    let copy = if entry.companion_of.iter().any(|id| id == COMPRESSED_COPY) { installed_copy().await } else { None };
    choose_in(state.db_manager.pool(), entry, &companion_dir(entry), copy.as_deref()).await?;
    let _ = app.emit("post-call-transcript-config-changed", ());
    log::info!("[speech-choice] {} is the after-meeting model", entry.id);
    Ok(())
}

/// [`chosen`] apart from the app: saves the choice in `pool` and, with the
/// Compressed copy installed at `copy`, leaves the marker in `dir`.
#[cfg(windows)]
async fn choose_in(pool: &sqlx::SqlitePool, entry: &Entry, dir: &Path, copy: Option<&Path>) -> Result<(), String> {
    SettingsRepository::save_post_call_transcript_config(pool, "whisper", &entry.id)
        .await
        .map_err(|error| format!("The Intel GPU version is installed, but Protocol could not use it after meetings: {error}"))?;
    if let Some(copy) = copy {
        if let Err(error) = write_marker(dir, copy) {
            // The copy then stays; nothing else depends on the marker.
            log::warn!("[speech-choice] could not leave {CHOSEN_MARKER}: {error}");
        }
    }
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
    /// Another import or retranscription runs or waits to start.
    pub other_pass: bool,
    /// The model the pass was asked for (a pick in Import or Enhance
    /// transcript), when Whisper ran it.
    pub requested: Option<&'a str>,
    /// The live provider and model (`localWhisper`/`parakeet`/…).
    pub live: (&'a str, &'a str),
    /// The after-meeting provider and model (`live`/`whisper`/`parakeet`).
    pub post_call: (&'a str, &'a str),
    /// The ggml model whisper.cpp holds now, also behind the Intel GPU
    /// version's id when that fell back to it.
    pub loaded: Option<&'a str>,
}

/// Whether `copy` retires: chosen through the card or the offer, proved by a
/// pass on the Intel GPU, and used nowhere — neither live nor after meetings
/// (also not through "Same as during the meeting"), not asked for by the
/// pass, not loaded, and no recording or other pass running that could load
/// it. A live choice of an Intel GPU version that serves `copy` uses it too:
/// recording falls back to it when the Intel GPU does not start, and
/// without it recording could not start at all. After meetings that
/// fallback may fail with a clear message; during a meeting it may not.
pub fn retires_copy(copy: &str, facts: &CopyUse) -> bool {
    let serves_copy = |model: &str| {
        model == copy || gpu_version(model).is_some_and(|version| version.companion_of.iter().any(|id| id == copy))
    };
    let live_uses = matches!(facts.live.0, "localWhisper" | "whisper") && serves_copy(facts.live.1);
    let post_call_uses = facts.post_call.0 == "whisper" && facts.post_call.1 == copy;
    facts.chosen
        && facts.copy_installed
        && facts.ran_on_gpu
        && !facts.recording
        && !facts.other_pass
        && facts.requested != Some(copy)
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

/// Called when a retranscription or an import succeeded, after its own
/// in-progress flag dropped; `ran_on_gpu` is [`runs_on_gpu`] at its end and
/// `requested` the Whisper model the pass was asked for. The check and the
/// removal run on their own task, after the pass has released the engine.
pub fn after_post_meeting_pass<R: Runtime>(app: AppHandle<R>, ran_on_gpu: bool, requested: Option<String>) {
    #[cfg(not(windows))]
    let _ = (app, ran_on_gpu, requested);
    #[cfg(windows)]
    if ran_on_gpu {
        tauri::async_runtime::spawn(async move {
            match retire_copy(&app, requested).await {
                Ok(true) => log::info!("[speech-choice] removed {COMPRESSED_COPY}: the Intel GPU version transcribed a meeting"),
                Ok(false) => {}
                Err(error) => log::warn!("[speech-choice] could not remove {COMPRESSED_COPY}: {error:#}"),
            }
        });
    }
}

/// Leaves [`CHOSEN_MARKER`] in the companion folder `dir`, naming the copy
/// at `copy` as it is now. It is written beside it and renamed into place:
/// the card's status check and a pass read it without a lock (`chosen`
/// runs after the download announced the companion, and the card refreshes
/// on that), and must find no marker or a whole one, never a part of the
/// text that would read as a marker for another copy.
#[cfg(windows)]
fn write_marker(dir: &Path, copy: &Path) -> std::io::Result<()> {
    let file = copy_file(copy).ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "the copy is not on disk"))?;
    let partial = dir.join(PARTIAL_MARKER);
    std::fs::write(&partial, marker_text(&file))?;
    std::fs::rename(&partial, dir.join(CHOSEN_MARKER))
}

/// For Settings: whether the Compressed copy waits to retire after the
/// Intel GPU version's first meeting. It only reads; a marker that outlived
/// its copy is removed by the next pass ([`retire`]).
#[cfg(windows)]
#[tauri::command]
pub fn speech_choice_copy_retires() -> bool {
    let copy = model_catalog::entry(Engine::Whisper, COMPRESSED_COPY)
        .map(|entry| crate::paths::models_dir().join(&entry.single_file().name))
        .filter(|path| path.is_file());
    !read_markers(&marker_dirs(), copy.as_deref()).current.is_empty()
}

/// The folders of the companions that serve the Compressed copy, where
/// [`CHOSEN_MARKER`] may be.
#[cfg(windows)]
fn marker_dirs() -> Vec<PathBuf> {
    model_catalog::companions()
        .iter()
        .filter(|entry| entry.companion_of.iter().any(|id| id == COMPRESSED_COPY))
        .map(companion_dir)
        .collect()
}

/// The markers in some companion folders, sorted by what they say about the
/// installed copy.
#[cfg(windows)]
#[derive(Debug, Default)]
struct Markers {
    /// Name the copy as it is now.
    current: Vec<PathBuf>,
    /// Read whole, and name another file or no copy is installed: they
    /// outlived the copy they were written for (removed in All models,
    /// downloaded again, or gone in a crash).
    stale: Vec<PathBuf>,
}

/// Reads the markers in `dirs` against the copy at `copy`. One that cannot
/// be read is neither: it does not retire the copy, and it is not removed.
#[cfg(windows)]
fn read_markers(dirs: &[PathBuf], copy: Option<&Path>) -> Markers {
    let expected = copy.and_then(copy_file).map(|file| marker_text(&file));
    let mut markers = Markers::default();
    for marker in dirs.iter().map(|dir| dir.join(CHOSEN_MARKER)).filter(|marker| marker.is_file()) {
        match std::fs::read_to_string(&marker) {
            Ok(text) if expected.as_deref() == Some(text.as_str()) => markers.current.push(marker),
            Ok(_) => markers.stale.push(marker),
            Err(error) => log::warn!("[speech-choice] could not read {}: {error}", marker.display()),
        }
    }
    markers
}

/// What [`retire`] cannot read from disk or from the settings.
#[cfg(windows)]
#[derive(Debug, Clone, Default)]
pub(crate) struct PassFacts<'a> {
    pub recording: bool,
    pub other_pass: bool,
    pub requested: Option<&'a str>,
    /// whisper.cpp holds the copy (also behind the Intel GPU version's id).
    pub holds_copy: bool,
}

/// The retirement itself, apart from the app's globals: the markers in
/// `marker_dirs`, the installed copy's file `copy`, the choices in `pool`.
/// `delete` removes the copy; it runs only after the markers are gone, so a
/// failed marker removal or a crash leaves the copy, never a marker that
/// could later remove another one.
#[cfg(windows)]
async fn retire<F, Fut>(marker_dirs: &[PathBuf], copy: Option<&Path>, pool: &sqlx::SqlitePool, pass: &PassFacts<'_>, delete: F) -> Result<bool>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let Markers { current: markers, stale } = read_markers(marker_dirs, copy);
    // Only a pass removes them, under the optional Whisper operation; the
    // card's check only reads.
    for marker in &stale {
        match std::fs::remove_file(marker) {
            Ok(()) => log::info!("[speech-choice] removed {}: the copy it was written for is gone", marker.display()),
            Err(error) => log::warn!("[speech-choice] could not remove {}, which names no installed copy: {error}", marker.display()),
        }
    }
    if markers.is_empty() {
        return Ok(false);
    }
    let live = SettingsRepository::get_transcript_config(pool).await?;
    let post_call = SettingsRepository::get_post_call_transcript_config(pool).await?.unwrap_or_else(|| ("live".into(), String::new()));
    let facts = CopyUse {
        chosen: true,
        copy_installed: copy.is_some(),
        ran_on_gpu: true,
        recording: pass.recording,
        other_pass: pass.other_pass,
        requested: pass.requested,
        live: live.as_ref().map_or(("", ""), |live| (live.provider.as_str(), live.model.as_str())),
        post_call: (post_call.0.as_str(), post_call.1.as_str()),
        loaded: pass.holds_copy.then_some(COMPRESSED_COPY),
    };
    if !retires_copy(COMPRESSED_COPY, &facts) {
        // Still chosen: a later pass may find the copy unused.
        return Ok(false);
    }
    for marker in &markers {
        std::fs::remove_file(marker).map_err(|error| anyhow!("could not remove {}: {error}", marker.display()))?;
    }
    delete().await?;
    Ok(true)
}

#[cfg(windows)]
async fn retire_copy<R: Runtime>(app: &AppHandle<R>, requested: Option<String>) -> Result<bool> {
    let dirs = marker_dirs();
    if !dirs.iter().any(|dir| dir.join(CHOSEN_MARKER).is_file()) {
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
    let copy = models
        .iter()
        .find(|model| model.name == COMPRESSED_COPY && matches!(model.status, ModelStatus::Available))
        .map(|model| model.path.clone());
    // Behind the Intel GPU version's id, whisper.cpp runs a regular copy
    // when OpenVINO did not take it: count it as the copy.
    let holds_copy = match engine.get_current_model().await.as_deref() {
        Some(id) if gpu_version(id).is_some() => engine.loaded_openvino().is_none() && engine.is_model_loaded().await,
        Some(id) => id == COMPRESSED_COPY,
        None => false,
    };
    let pool = app.state::<crate::state::AppState>().db_manager.pool().clone();
    let pass = PassFacts {
        recording: crate::audio::recording_commands::is_recording().await,
        other_pass: crate::audio::import::is_import_in_progress() || crate::audio::retranscription::is_retranscription_in_progress(),
        requested: requested.as_deref(),
        holds_copy,
    };
    let retired = retire(&dirs, copy.as_deref(), &pool, &pass, || async {
        engine.delete_model(COMPRESSED_COPY).await.map(|_| ())
    })
    .await?;
    if retired {
        // The optional Whisper job and the model lists refresh on this event.
        let _ = app.emit("optional-model-removed", "whisper");
    }
    Ok(retired)
}

/// Whether something uses the speech engines: `openvino_remove` refuses
/// then. The same rule as its own (`model_catalog::openvino`), asked first
/// so that a refused removal leaves the choices alone.
#[cfg(windows)]
fn engines_busy() -> bool {
    use crate::updater::busy::BusyReason;
    crate::updater::busy::current()
        .into_iter()
        .any(|reason| !matches!(reason, BusyReason::ModelDownload | BusyReason::Onboarding))
}

/// Removes the Intel GPU version `id` from the card: first moves every
/// choice of it to a regular copy (after meetings: the copy, else "Same as
/// during the meeting"; live: the copy, else Parakeet), as removing a ggml
/// model does, then `openvino_remove`. When that refuses (a download or a
/// transcription started meanwhile), the choices it moved go back.
#[cfg(windows)]
#[tauri::command]
pub async fn speech_choice_remove_gpu_version<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let entry = gpu_version(&id).ok_or_else(|| format!("{id} is not in the model list"))?;
    if engines_busy() {
        return Err("Protocol is transcribing right now. Remove it when it is done.".to_string());
    }
    let models = crate::whisper_engine::commands::whisper_get_available_models().await?;
    let copy = regular_copy(&entry, |name| {
        models.iter().any(|model| model.name == name && matches!(model.status, ModelStatus::Available))
    });
    let pool = app.state::<crate::state::AppState>().db_manager.pool().clone();
    let moved = move_choices(&pool, &id, copy.as_deref()).await.map_err(|error| error.to_string())?;
    let announce = |app: &AppHandle<R>| {
        let _ = app.emit("transcript-config-changed", ());
        let _ = app.emit("post-call-transcript-config-changed", ());
    };
    announce(&app);
    if let Err(refused) = model_catalog::openvino::openvino_remove(app.clone(), id.clone()).await {
        if let Err(error) = restore_choices(&pool, &id, copy.as_deref(), &moved).await {
            log::error!("[speech-choice] the removal of {id} was refused, and its choices could not be restored: {error}");
        }
        announce(&app);
        return Err(refused);
    }
    Ok(())
}

/// Which choices [`move_choices`] moved, to put them back.
#[cfg(windows)]
#[derive(Debug, Default, PartialEq, Eq)]
struct Moved {
    post_call: bool,
    /// The live provider spelling it had (`localWhisper` or `whisper`).
    live_provider: Option<String>,
}

#[cfg(windows)]
fn moved_to(copy: Option<&str>) -> ((&str, &str), (&str, &str)) {
    let post_call = copy.map_or(("live", ""), |copy| ("whisper", copy));
    let live = copy.map_or(("parakeet", crate::config::DEFAULT_PARAKEET_MODEL), |copy| ("localWhisper", copy));
    (post_call, live)
}

#[cfg(windows)]
async fn move_choices(pool: &sqlx::SqlitePool, id: &str, copy: Option<&str>) -> std::result::Result<Moved, sqlx::Error> {
    let ((post_provider, post_model), (live_provider, live_model)) = moved_to(copy);
    let mut transaction = pool.begin().await?;
    let previous_live: Option<String> =
        sqlx::query_scalar("SELECT provider FROM transcript_settings WHERE provider IN ('localWhisper', 'whisper') AND model = ? LIMIT 1")
            .bind(id)
            .fetch_optional(&mut *transaction)
            .await?;
    let post_call = sqlx::query("UPDATE transcript_settings SET postCallProvider = ?, postCallModel = ? WHERE postCallProvider = 'whisper' AND postCallModel = ?")
        .bind(post_provider)
        .bind(post_model)
        .bind(id)
        .execute(&mut *transaction)
        .await?
        .rows_affected()
        > 0;
    sqlx::query("UPDATE transcript_settings SET provider = ?, model = ? WHERE provider IN ('localWhisper', 'whisper') AND model = ?")
        .bind(live_provider)
        .bind(live_model)
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(Moved { post_call, live_provider: previous_live })
}

/// Puts back what [`move_choices`] moved, where the choice is still what it
/// wrote: one the person made meanwhile stays.
#[cfg(windows)]
async fn restore_choices(pool: &sqlx::SqlitePool, id: &str, copy: Option<&str>, moved: &Moved) -> std::result::Result<(), sqlx::Error> {
    let ((post_provider, post_model), (live_provider, live_model)) = moved_to(copy);
    let mut transaction = pool.begin().await?;
    if moved.post_call {
        sqlx::query("UPDATE transcript_settings SET postCallProvider = 'whisper', postCallModel = ? WHERE postCallProvider = ? AND postCallModel = ?")
            .bind(id)
            .bind(post_provider)
            .bind(post_model)
            .execute(&mut *transaction)
            .await?;
    }
    if let Some(provider) = &moved.live_provider {
        sqlx::query("UPDATE transcript_settings SET provider = ?, model = ? WHERE provider = ? AND model = ?")
            .bind(provider)
            .bind(id)
            .bind(live_provider)
            .bind(live_model)
            .execute(&mut *transaction)
            .await?;
    }
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
            other_pass: false,
            requested: None,
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
        stays(CopyUse { other_pass: true, ..proved() });
        stays(CopyUse { loaded: Some(COPY), ..proved() });
        // Picked in Import or Enhance transcript, and run by its companion in place.
        stays(CopyUse { requested: Some(COPY), ..proved() });
        // A live Intel GPU version falls back to the copy when the GPU does
        // not start; without it recording could not start.
        stays(CopyUse { live: ("localWhisper", GPU), ..proved() });
        stays(CopyUse { live: ("localWhisper", GPU), post_call: ("live", ""), ..proved() });
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
        assert!(retires_copy(COPY, &CopyUse { requested: Some(GPU), ..proved() }));
        assert!(retires_copy(COPY, &CopyUse { live: ("localWhisper", "small"), ..proved() }));
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
    fn without_a_copy_the_message_names_the_model_and_what_to_do() {
        let message = no_copy_message(&version());
        assert!(message.starts_with("Whisper Large V3 Turbo · Intel GPU didn't start"), "{message}");
        assert!(message.contains("Download the standard version"));
        assert!(!message.contains("OpenVINO") && !message.contains(GPU), "{message}");
        // The passes' load errors name it the same way; other models keep their id.
        assert_eq!(shown_name(GPU), "Large V3 Turbo · Intel GPU");
        assert_eq!(shown_name("small"), "small");
    }

    #[tokio::test]
    async fn a_gpu_version_without_its_files_or_a_copy_fails_with_that_message() {
        // An empty models folder: no companion (the app's folder beside the
        // test binary has none either) and no regular copy.
        let models = tempfile::tempdir().unwrap();
        let engine = crate::whisper_engine::WhisperEngine::new_with_models_dir(Some(models.path().to_path_buf())).unwrap();
        let error = engine.load_model(GPU).await.unwrap_err().to_string();
        assert_eq!(error, no_copy_message(&version()));
        assert_eq!(engine.get_current_model().await, None);
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
        let moved = move_choices(&pool, GPU, Some(COPY)).await.unwrap();
        assert_eq!(row().await, ("localWhisper".into(), COPY.into(), "whisper".into(), COPY.into()));
        // A refused removal puts them back…
        restore_choices(&pool, GPU, Some(COPY), &moved).await.unwrap();
        assert_eq!(row().await, ("localWhisper".into(), GPU.into(), "whisper".into(), GPU.into()));
        // …except a choice made meanwhile.
        let moved = move_choices(&pool, GPU, Some(COPY)).await.unwrap();
        sqlx::query("UPDATE transcript_settings SET postCallModel = 'small'").execute(&pool).await.unwrap();
        restore_choices(&pool, GPU, Some(COPY), &moved).await.unwrap();
        assert_eq!(row().await, ("localWhisper".into(), GPU.into(), "whisper".into(), "small".into()));

        sqlx::query("UPDATE transcript_settings SET provider = 'localWhisper', model = ?, postCallProvider = 'whisper', postCallModel = ?")
            .bind(GPU)
            .bind(GPU)
            .execute(&pool)
            .await
            .unwrap();
        let moved = move_choices(&pool, GPU, None).await.unwrap();
        assert_eq!(row().await, ("parakeet".into(), crate::config::DEFAULT_PARAKEET_MODEL.into(), "live".into(), "".into()));
        restore_choices(&pool, GPU, None, &moved).await.unwrap();
        assert_eq!(row().await, ("localWhisper".into(), GPU.into(), "whisper".into(), GPU.into()));
        move_choices(&pool, GPU, None).await.unwrap();

        // Choices of other models are left alone.
        sqlx::query("UPDATE transcript_settings SET provider = 'parakeet', model = 'p', postCallProvider = 'whisper', postCallModel = 'small'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(move_choices(&pool, GPU, Some(COPY)).await.unwrap(), Moved::default());
        assert_eq!(row().await, ("parakeet".into(), "p".into(), "whisper".into(), "small".into()));
    }

    /// A companion folder and a models folder with a stand-in for the copy:
    /// the retirement reads only its file's identity.
    #[cfg(windows)]
    struct Disk {
        _root: tempfile::TempDir,
        companion: PathBuf,
        copy: PathBuf,
        downloads: std::cell::Cell<u64>,
    }

    #[cfg(windows)]
    impl Disk {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let companion = root.path().join("whisper-large-v3-turbo-openvino-int8");
            std::fs::create_dir(&companion).unwrap();
            let copy = root.path().join("ggml-large-v3-turbo-q5_0.bin");
            let disk = Disk { _root: root, companion, copy, downloads: std::cell::Cell::new(0) };
            disk.download_copy();
            disk
        }

        /// The copy downloaded (again): a new file with the same bytes.
        fn download_copy(&self) {
            std::fs::write(&self.copy, b"ggml").unwrap();
            // Later than any earlier download of it, as a real one is.
            self.downloads.set(self.downloads.get() + 1);
            let later = std::time::SystemTime::now() + std::time::Duration::from_secs(self.downloads.get());
            std::fs::File::options().write(true).open(&self.copy).unwrap().set_modified(later).unwrap();
        }

        fn marker(&self) -> PathBuf {
            self.companion.join(CHOSEN_MARKER)
        }

        /// What `chosen` leaves while the copy is installed.
        fn choose(&self) {
            write_marker(&self.companion, &self.copy).unwrap();
        }

        /// The markers Settings' check counts (`speech_choice_copy_retires`).
        fn waiting(&self) -> Vec<PathBuf> {
            let copy = self.copy.is_file().then(|| self.copy.clone());
            read_markers(&[self.companion.clone()], copy.as_deref()).current
        }

        /// A pass on the Intel GPU ended: the retirement as `retire_copy`
        /// runs it, the copy's removal as `delete_model` does it.
        async fn pass(&self, pool: &sqlx::SqlitePool, facts: PassFacts<'_>) -> Result<bool> {
            let copy = self.copy.is_file().then(|| self.copy.clone());
            retire(&[self.companion.clone()], copy.as_deref(), pool, &facts, || async {
                std::fs::remove_file(&self.copy)?;
                Ok(())
            })
            .await
        }
    }

    /// The settings database with the live and after-meeting choices.
    #[cfg(windows)]
    async fn choices(live: (&str, &str), post_call: (&str, &str)) -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        SettingsRepository::save_transcript_config(&pool, live.0, live.1).await.unwrap();
        SettingsRepository::save_post_call_transcript_config(&pool, post_call.0, post_call.1).await.unwrap();
        pool
    }

    #[cfg(windows)]
    const PARAKEET: (&str, &str) = ("parakeet", "parakeet-tdt-0.6b-v3-int8");

    #[cfg(windows)]
    #[tokio::test]
    async fn choosing_saves_it_after_meetings_and_names_the_copy_on_disk() {
        let disk = Disk::new();
        let pool = choices(PARAKEET, ("whisper", COPY)).await;
        choose_in(&pool, &version(), &disk.companion, Some(&disk.copy)).await.unwrap();
        let saved = SettingsRepository::get_post_call_transcript_config(&pool).await.unwrap();
        assert_eq!(saved, Some(("whisper".to_string(), GPU.to_string())));
        assert_eq!(disk.waiting(), vec![disk.marker()]);
        // The live choice is not touched.
        let live = SettingsRepository::get_transcript_config(&pool).await.unwrap().unwrap();
        assert_eq!((live.provider.as_str(), live.model.as_str()), PARAKEET);

        // Without the copy installed there is nothing to retire.
        let disk = Disk::new();
        choose_in(&pool, &version(), &disk.companion, None).await.unwrap();
        assert!(!disk.marker().exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn the_copy_retires_once_and_a_copy_downloaded_later_stays() {
        let disk = Disk::new();
        let pool = choices(PARAKEET, ("whisper", GPU)).await;
        disk.choose();
        assert!(disk.pass(&pool, PassFacts::default()).await.unwrap());
        assert!(!disk.copy.exists() && !disk.marker().exists());
        // The standard version downloaded after a failure: no marker names it.
        disk.download_copy();
        assert!(!disk.pass(&pool, PassFacts::default()).await.unwrap());
        assert!(disk.copy.exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_marker_never_removes_a_copy_other_than_its_own() {
        let pool = choices(PARAKEET, ("whisper", GPU)).await;
        // Removed in All models after the switch, then downloaded again as
        // the standard version: the old marker names the old file.
        let disk = Disk::new();
        disk.choose();
        std::fs::remove_file(&disk.copy).unwrap();
        disk.download_copy();
        assert!(!disk.pass(&pool, PassFacts::default()).await.unwrap());
        assert!(disk.copy.exists());
        assert!(!disk.marker().exists(), "a marker that names no copy goes");

        // Removed, and a pass before any new download: the marker goes then.
        let disk = Disk::new();
        disk.choose();
        std::fs::remove_file(&disk.copy).unwrap();
        assert!(!disk.pass(&pool, PassFacts::default()).await.unwrap());
        assert!(!disk.marker().exists());
        disk.download_copy();
        assert!(!disk.pass(&pool, PassFacts::default()).await.unwrap());
        assert!(disk.copy.exists());

        // Settings asking whether the copy waits to retire: such a marker
        // counts for nothing there, and only the next pass removes it.
        let disk = Disk::new();
        disk.choose();
        assert_eq!(disk.waiting(), vec![disk.marker()]);
        disk.download_copy();
        assert!(disk.waiting().is_empty());
        assert!(disk.marker().exists(), "the card's check only reads");
        assert!(!disk.pass(&pool, PassFacts::default()).await.unwrap());
        assert!(!disk.marker().exists());
        assert!(disk.copy.exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_marker_is_read_whole_or_left_alone() {
        use std::os::windows::fs::OpenOptionsExt;
        let pool = choices(PARAKEET, ("whisper", GPU)).await;
        let disk = Disk::new();
        disk.choose();
        assert!(!disk.companion.join(PARTIAL_MARKER).exists(), "written beside it and renamed into place");
        assert_eq!(std::fs::read_to_string(disk.marker()).unwrap(), marker_text(&copy_file(&disk.copy).unwrap()));

        // A reader holding the marker (as the card's check opens it) does
        // not stop a new switch from replacing it.
        {
            let _reader = std::fs::File::open(disk.marker()).unwrap();
            disk.choose();
        }

        // A marker that cannot be read, as one held open without sharing:
        // it neither retires the copy nor is removed.
        {
            let _held = std::fs::File::options().read(true).share_mode(0).open(disk.marker()).unwrap();
            assert!(disk.waiting().is_empty());
            assert!(!disk.pass(&pool, PassFacts::default()).await.unwrap());
        }
        assert!(disk.marker().exists());
        assert!(disk.copy.exists());

        // A part of a write a crash left beside it is never read as a marker.
        let disk = Disk::new();
        std::fs::write(disk.companion.join(PARTIAL_MARKER), &marker_text(&copy_file(&disk.copy).unwrap())[..5]).unwrap();
        assert!(disk.waiting().is_empty());
        assert!(!disk.pass(&pool, PassFacts::default()).await.unwrap());
        assert!(disk.copy.exists());
        disk.choose();
        assert!(!disk.companion.join(PARTIAL_MARKER).exists());
        assert!(disk.pass(&pool, PassFacts::default()).await.unwrap());
        assert!(!disk.copy.exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_marker_that_cannot_be_removed_keeps_the_copy() {
        use std::os::windows::fs::OpenOptionsExt;
        let disk = Disk::new();
        let pool = choices(PARAKEET, ("whisper", GPU)).await;
        disk.choose();
        {
            // Held open sharing reads only (FILE_SHARE_READ): the marker can
            // be read but not removed, as in a crash before the copy went.
            let _held = std::fs::File::options().read(true).share_mode(1).open(disk.marker()).unwrap();
            assert!(disk.pass(&pool, PassFacts::default()).await.is_err());
            assert!(disk.copy.exists());
        }
        assert!(disk.pass(&pool, PassFacts::default()).await.unwrap());
        assert!(!disk.copy.exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn the_copy_stays_while_anything_could_load_it() {
        let disk = Disk::new();
        disk.choose();
        let after_gpu = choices(PARAKEET, ("whisper", GPU)).await;
        for facts in [
            PassFacts { recording: true, ..PassFacts::default() },
            PassFacts { other_pass: true, ..PassFacts::default() },
            PassFacts { requested: Some(COPY), ..PassFacts::default() },
            PassFacts { holds_copy: true, ..PassFacts::default() },
        ] {
            assert!(!disk.pass(&after_gpu, facts.clone()).await.unwrap(), "{facts:?}");
        }
        for (live, post_call) in [
            // The live Intel GPU version falls back to it (recording start).
            (("localWhisper", GPU), ("whisper", GPU)),
            (("localWhisper", GPU), ("live", "")),
            (("localWhisper", COPY), ("whisper", GPU)),
            (PARAKEET, ("whisper", COPY)),
        ] {
            let pool = choices(live, post_call).await;
            assert!(!disk.pass(&pool, PassFacts::default()).await.unwrap(), "{live:?} {post_call:?}");
        }
        assert!(disk.copy.exists() && disk.marker().exists());
        // Once nothing does, it goes.
        assert!(disk.pass(&after_gpu, PassFacts::default()).await.unwrap());
    }
}
