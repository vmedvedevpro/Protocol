//! Keeps the catalog in use current and the installed models up to date.
//!
//! At launch the cached catalog is put in use and interrupted model updates
//! are finished or rolled back. Once a day while "Check for updates
//! automatically" is on (the updater's scheduler calls [`tick`]), or when the
//! user clicks Check for model updates, the catalog is fetched from `main` and
//! every installed model is compared with Hugging Face. Updates found are
//! offered on the model's card in Settings; the user starts each one
//! ([`start_update`]). Every change is pushed to the WebView as
//! [`CHANGED_EVENT`], and Settings then lists the models again.
//!
//! The history (last check, failures, last error, the updates found and the
//! last failed update per model) is kept beside the cached catalog, so
//! restarts follow the same 24 h schedule and backoff as app updates
//! (`crate::updater::schedule`) and keep showing what was found.
//!
//! The check also reads again the model sizes a list asked Hugging Face for
//! (`super::sizes`); a list asks for missing ones itself ([`request_sizes`]),
//! whether automatic checks are on or not, since that is part of showing it.

use super::huggingface::{self, HubError};
use super::remote::{self, FetchError, Source};
use super::schema::{Engine, Entry, Hidden};
use super::sizes;
use super::updates::{self, Available, Hooks, Phase, Unit};
use crate::updater::busy::{self, BusyReason};
use crate::updater::prefs::Prefs;
use crate::updater::{now_ms, schedule};
use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio_util::sync::CancellationToken;

pub const CHANGED_EVENT: &str = "model-catalog-changed";

/// How often an update waiting for recordings and summaries looks again.
const IDLE_POLL: Duration = Duration::from_secs(3);
/// Progress is pushed at most this often.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

/// The last update of a model that failed, shown on its card until the next try.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFailure {
    pub engine: Engine,
    pub id: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct History {
    /// Unix ms of the last check GitHub and Hugging Face answered, even if
    /// the answer was an error about the model list or one model.
    last_checked_at: Option<i64>,
    last_attempt_at: Option<i64>,
    /// Failed automatic checks since the last completed one.
    failures: u32,
    /// When the catalog in use was fetched, if it came from `main`.
    fetched_at: Option<i64>,
    /// What went wrong in the last check: why it did not complete, or why
    /// the model list from `main` could not be used.
    error: Option<String>,
    updates: Vec<Available>,
    update_failures: Vec<UpdateFailure>,
    /// Installed models Hugging Face answered for with an error in the last
    /// check (a removed or gated repository, a missing file), shown on their
    /// cards. They do not fail the check.
    check_failures: Vec<UpdateFailure>,
}

impl History {
    /// `completed`: GitHub and Hugging Face answered. Only an incomplete
    /// check is retried sooner than in a day, with the updater's backoff.
    fn record(&mut self, manual: bool, completed: bool, error: Option<String>, now: i64) {
        // The updater's rule: a completed check resets the failures, a failed
        // manual one does not count.
        let mut prefs = self.schedule(true);
        prefs.record_check(manual, completed, now);
        self.last_checked_at = prefs.last_checked_at;
        self.last_attempt_at = prefs.last_attempt_at;
        self.failures = prefs.failures;
        self.error = error;
    }

    fn schedule(&self, auto_check: bool) -> Prefs {
        Prefs {
            auto_check,
            last_checked_at: self.last_checked_at,
            last_attempt_at: self.last_attempt_at,
            failures: self.failures,
        }
    }

    fn forget(&mut self, engine: Engine, id: &str) {
        self.updates.retain(|update| !(update.engine == engine && update.id == id));
        self.update_failures.retain(|failure| !(failure.engine == engine && failure.id == id));
        self.check_failures.retain(|failure| !(failure.engine == engine && failure.id == id));
    }
}

/// An update in progress.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub engine: Engine,
    pub id: String,
    pub phase: Phase,
    pub done_bytes: u64,
    pub total_bytes: u64,
    #[serde(skip)]
    cancel: CancellationToken,
}

/// What Settings shows about the catalog and model updates.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub source: Source,
    pub fetched_at: Option<i64>,
    pub last_checked_at: Option<i64>,
    pub checking: bool,
    pub error: Option<String>,
    /// Entries of the catalog in use that were left out, and why.
    pub hidden: Vec<Hidden>,
    pub updates: Vec<Available>,
    pub operations: Vec<Operation>,
    pub update_failures: Vec<UpdateFailure>,
    /// Installed models the last check got an error for from Hugging Face.
    pub check_failures: Vec<UpdateFailure>,
    /// Changes when model sizes read from Hugging Face changed, so Settings
    /// lists the models again.
    pub sizes_version: u64,
}

pub struct CatalogState {
    dir: PathBuf,
    history: Mutex<History>,
    checking: AtomicBool,
    /// One check at a time; a second one waits and then runs.
    running: tokio::sync::Mutex<()>,
    operations: Mutex<HashMap<(Engine, String), Operation>>,
}

impl CatalogState {
    fn history(&self) -> std::sync::MutexGuard<'_, History> {
        self.history.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn operations(&self) -> std::sync::MutexGuard<'_, HashMap<(Engine, String), Operation>> {
        self.operations.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn status(&self) -> Status {
        let history = self.history().clone();
        let mut operations: Vec<Operation> = self.operations().values().cloned().collect();
        operations.sort_by(|a, b| (a.engine.as_str(), &a.id).cmp(&(b.engine.as_str(), &b.id)));
        Status {
            source: super::source(),
            fetched_at: history.fetched_at,
            last_checked_at: history.last_checked_at,
            checking: self.checking.load(Ordering::Acquire),
            error: history.error,
            hidden: super::active().hidden.clone(),
            updates: history.updates,
            operations,
            update_failures: history.update_failures,
            check_failures: history.check_failures,
            sizes_version: sizes::version(),
        }
    }

    fn save(&self) {
        let history = self.history().clone();
        let path = history_file(&self.dir);
        // Atomic: a cut-short write would reset the schedule and the updates
        // found, and the next start would check at once.
        let result = serde_json::to_vec_pretty(&history)
            .map_err(std::io::Error::from)
            .and_then(|bytes| super::write_atomically(&path, &bytes));
        if let Err(error) = result {
            log::warn!("[model catalog] could not save {}: {error}", path.display());
        }
    }
}

fn history_file(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

/// Finishes or rolls back interrupted model updates, puts the cached catalog
/// in use and registers the state. Call before the engines list their models.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    updates::recover(&crate::paths::models_dir());
    let dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| crate::paths::install_data_root().join("cache"))
        .join("model-catalog");
    let (catalog, source) = remote::startup(&dir, super::built_in());
    log::info!("[model catalog] {} models from {:?}", catalog.entries.len(), source);
    super::set_active(catalog, source);
    sizes::load(&dir);
    let history = std::fs::read(history_file(&dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    app.manage(CatalogState {
        dir,
        history: Mutex::new(history),
        checking: AtomicBool::new(false),
        running: tokio::sync::Mutex::new(()),
        operations: Mutex::new(HashMap::new()),
    });
}

/// Applies a fetched document: one that can be used becomes the catalog in
/// use and the cached copy; anything else leaves both as they are. Returns
/// whether the models offered changed.
fn apply_fetch(dir: &Path, fetched: Result<Vec<u8>, FetchError>) -> Result<bool, FetchError> {
    let bytes = fetched?;
    let catalog = remote::usable(&bytes).map_err(|error| FetchError::answered(error.to_string()))?;
    for hidden in &catalog.hidden {
        log::warn!("[model catalog] entry {} ({:?}) hidden: {}", hidden.index, hidden.id, hidden.problem);
    }
    if let Err(error) = remote::write_cache(dir, &bytes) {
        log::warn!("[model catalog] could not keep the model list for offline starts: {error}");
    }
    Ok(super::set_active(Arc::new(catalog), Source::Remote))
}

pub fn emit<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<CatalogState>() else { return };
    if let Err(error) = app.emit(CHANGED_EVENT, state.status()) {
        log::warn!("[model catalog] could not push the status: {error}");
    }
}

/// Every installed model the catalog knows, with where it lives.
fn installed_units(models_root: &Path) -> Vec<(Entry, Unit)> {
    [Engine::Whisper, Engine::Parakeet, Engine::Llama]
        .into_iter()
        .flat_map(|engine| super::entries_with_installed(engine, |entry| Unit::of(models_root, entry).installed(entry).is_some()))
        .filter_map(|entry| {
            let unit = Unit::of(models_root, &entry);
            unit.installed(&entry).is_some().then_some((entry, unit))
        })
        .collect()
}

/// Compares every installed model under `models_root` with `hub`. A model
/// that was not checked (being updated, or Hugging Face could not be asked)
/// keeps what the last check found. An error Hugging Face answered with (a
/// removed or gated repository, a missing file) is kept for the model's card
/// and does not fail the check, since asking again sooner would get the same
/// answer. Fails only when Hugging Face could not be asked.
async fn check_installed(state: &CatalogState, models_root: &Path, hub: &str) -> Result<(), String> {
    let client = huggingface::client();
    let (previous, previous_failures) = {
        let history = state.history();
        (history.updates.clone(), history.check_failures.clone())
    };
    let mut found = Vec::new();
    let mut failures = Vec::new();
    let mut unreached = Vec::new();
    for (entry, unit) in installed_units(models_root) {
        let mine = |engine: Engine, id: &str| engine == entry.engine && id == entry.id;
        let keep = |found: &mut Vec<Available>, failures: &mut Vec<UpdateFailure>| {
            found.extend(previous.iter().filter(|update| mine(update.engine, &update.id)).cloned());
            failures.extend(previous_failures.iter().filter(|failure| mine(failure.engine, &failure.id)).cloned());
        };
        if state.operations().contains_key(&(entry.engine, entry.id.clone())) {
            keep(&mut found, &mut failures);
            continue;
        }
        match updates::check(&client, hub, &entry, &unit).await {
            Ok(available) => found.extend(available),
            Err(error) if error.downcast_ref::<HubError>().is_some_and(HubError::is_transient) => {
                log::warn!("[model catalog] could not check {} for updates: {error}", entry.id);
                keep(&mut found, &mut failures);
                unreached.push(format!("{}: {error}", entry.name));
            }
            Err(error) => {
                log::warn!("[model catalog] checking {} for updates failed: {error}", entry.id);
                found.extend(previous.iter().filter(|update| mine(update.engine, &update.id)).cloned());
                failures.push(UpdateFailure { engine: entry.engine, id: entry.id.clone(), message: error.to_string() });
            }
        }
    }
    {
        let mut history = state.history();
        history.updates = found;
        history.check_failures = failures;
    }
    match unreached.len() {
        0 => Ok(()),
        1 => Err(unreached.remove(0)),
        more => Err(format!("{} (and {} more)", unreached[0], more - 1)),
    }
}

/// Fetches the catalog from `main`, puts it in use, and checks the installed
/// models for updates. Neither failure changes the models or the lists.
pub async fn check<R: Runtime>(app: &AppHandle<R>, manual: bool) -> Result<Status, String> {
    let state = app.try_state::<CatalogState>().ok_or("The model list is still loading")?;
    let _running = state.running.lock().await;
    state.checking.store(true, Ordering::Release);
    emit(app);

    let fetched = remote::fetch(&huggingface::client(), remote::CATALOG_URL).await;
    let now = now_ms();
    let catalog = apply_fetch(&state.dir, fetched);
    match &catalog {
        Ok(changed) => {
            log::info!("[model catalog] fetched from main ({})", if *changed { "changed" } else { "unchanged" });
            state.history().fetched_at = Some(now);
        }
        Err(error) => log::warn!("[model catalog] fetch failed; keeping the {:?} list: {}", super::source(), error.message),
    }
    // Hugging Face is asked even when GitHub was not reachable.
    let models = check_installed(&state, &crate::paths::models_dir(), huggingface::HUB).await;
    // Display only: a failure leaves the sizes as they were and does not
    // count against the check.
    let every: Vec<Entry> = [Engine::Whisper, Engine::Parakeet, Engine::Llama].into_iter().flat_map(super::entries).collect();
    sizes::refresh(&huggingface::client(), huggingface::HUB, &every).await;
    // Complete when GitHub and Hugging Face answered, even with a 404 for
    // the list or an error for one model: asking again sooner than the daily
    // check would get the same answer.
    let completed = !catalog.as_ref().is_err_and(|error| error.transient) && models.is_ok();
    let error = catalog.err().map(|error| error.message).or(models.err());
    state.history().record(manual, completed, error, now);
    state.save();
    state.checking.store(false, Ordering::Release);
    emit(app);
    Ok(state.status())
}

/// A model list of `engine` (or a line naming the models `ids`) is on screen:
/// reads the sizes of those listed models that are not known yet from
/// Hugging Face, in the background, and pushes the status when they arrived.
pub fn request_sizes<R: Runtime>(app: &AppHandle<R>, engine: Engine, ids: Option<Vec<String>>) {
    let entries: Vec<Entry> = super::entries(engine)
        .into_iter()
        .filter(|entry| entry.listed && ids.as_ref().map_or(true, |ids| ids.contains(&entry.id)))
        .collect();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if sizes::fill(&huggingface::client(), huggingface::HUB, &entries).await {
            emit(&app);
        }
    });
}

/// The size shown for the model `id`: its installed files (install record or
/// 0.3.0 pins), else what a download would fetch now; `None` while unknown.
pub fn model_size(engine: Engine, id: &str) -> Option<u64> {
    let entry = super::entry(engine, id)?;
    let unit = Unit::of(&crate::paths::models_dir(), &entry);
    unit.installed(&entry).map(|expected| expected.total_size()).or_else(|| sizes::download_size(&entry))
}

/// Called on the updater's schedule tick: runs a daily check while automatic
/// checks are on and onboarding is done.
pub async fn tick<R: Runtime>(app: &AppHandle<R>, auto_check: bool) {
    let Some(state) = app.try_state::<CatalogState>() else { return };
    let now = now_ms();
    let due = {
        let mut prefs = state.history().schedule(auto_check);
        schedule::normalize(&mut prefs, now);
        schedule::is_due(&prefs, now)
    };
    if due && busy::onboarding_complete() {
        let _ = check(app, false).await;
    }
}

/// Work that must not share the machine with a test load or a swap; a model
/// download or onboarding does not count.
fn engines_busy() -> bool {
    busy::current()
        .into_iter()
        .any(|reason| !matches!(reason, BusyReason::ModelDownload | BusyReason::Onboarding))
}

async fn wait_until_idle() {
    while engines_busy() {
        tokio::time::sleep(IDLE_POLL).await;
    }
}

fn hooks<R: Runtime>(app: AppHandle<R>, entry: &Entry) -> Hooks {
    let engine = entry.engine;
    let file = entry.single_file().name.clone();
    let model_def = crate::summary::summary_engine::ModelDef::from_entry(entry);
    let key = (entry.engine, entry.id.clone());
    let last_push = Mutex::new(Instant::now() - PROGRESS_INTERVAL);
    Hooks {
        wait_idle: Box::new(|| Box::pin(async { wait_until_idle().await; Ok(()) })),
        test_load: Box::new(move |dir| {
            Box::pin(async move {
                match engine {
                    Engine::Whisper => {
                        let path = dir.join(file);
                        tokio::task::spawn_blocking(move || {
                            // On the CPU, so the GPU stays with the loaded model.
                            let params = whisper_rs::WhisperContextParameters { use_gpu: false, ..Default::default() };
                            whisper_rs::WhisperContext::new_with_params(&path.to_string_lossy(), params)
                                .map(drop)
                                .map_err(|error| anyhow!("{error}"))
                        })
                        .await?
                    }
                    Engine::Parakeet => tokio::task::spawn_blocking(move || {
                        crate::parakeet_engine::ParakeetModel::new(&dir, true).map(drop).map_err(|error| anyhow!("{error}"))
                    })
                    .await?,
                    Engine::Llama => {
                        let model_def = model_def.ok_or_else(|| anyhow!("no summary settings"))?;
                        // Only one llama-helper holds memory at a time.
                        let _ = crate::summary::summary_engine::force_shutdown_sidecar().await;
                        crate::audio::common::mark_llm_unloaded();
                        crate::summary::summary_engine::client::probe_model(dir.join(file), &model_def).await
                    }
                }
            })
        }),
        lock_for_swap: Box::new(move || {
            Box::pin(async move {
                loop {
                    wait_until_idle().await;
                    let guard = crate::audio::common::acquire_engine_lifecycle_lock().await;
                    // A recording may have started while the lock was awaited.
                    if engines_busy() {
                        drop(guard);
                        continue;
                    }
                    match engine {
                        Engine::Whisper | Engine::Parakeet => crate::audio::common::unload_both_stt_engines().await,
                        Engine::Llama => {
                            let _ = crate::summary::summary_engine::force_shutdown_sidecar().await;
                            crate::audio::common::mark_llm_unloaded();
                        }
                    }
                    return Ok(Box::new(guard) as Box<dyn Send>);
                }
            })
        }),
        phase: Box::new(move |phase, done, total| {
            let Some(state) = app.try_state::<CatalogState>() else { return };
            let changed = state.operations().get_mut(&key).is_some_and(|operation| {
                let changed = operation.phase != phase;
                operation.phase = phase;
                operation.done_bytes = done;
                operation.total_bytes = total;
                changed
            });
            let mut last = last_push.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if changed || last.elapsed() >= PROGRESS_INTERVAL {
                *last = Instant::now();
                emit(&app);
            }
        }),
    }
}

/// Starts the update of an installed model; it runs on until it is done,
/// fails or is cancelled. Registers with the busy registry for its lifetime.
pub fn start_update<R: Runtime>(app: &AppHandle<R>, engine: Engine, id: &str) -> Result<Status, String> {
    let state = app.try_state::<CatalogState>().ok_or("The model list is still loading")?;
    let entry = super::entry(engine, id).ok_or_else(|| format!("{id} is not in the model list"))?;
    let unit = Unit::of(&crate::paths::models_dir(), &entry);
    if unit.installed(&entry).is_none() {
        return Err(format!("{} is not installed", entry.name));
    }
    let cancel = CancellationToken::new();
    {
        let mut operations = state.operations();
        let key = (engine, entry.id.clone());
        if operations.contains_key(&key) {
            return Err(format!("{} is already being updated", entry.name));
        }
        operations.insert(
            key,
            Operation { engine, id: entry.id.clone(), phase: Phase::Downloading, done_bytes: 0, total_bytes: 0, cancel: cancel.clone() },
        );
    }
    state.history().update_failures.retain(|failure| !(failure.engine == engine && failure.id == entry.id));
    emit(app);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _busy = busy::hold(BusyReason::ModelDownload);
        let api = huggingface::client();
        let files = huggingface::builder().connect_timeout(Duration::from_secs(30)).build().unwrap_or_default();
        let hooks = hooks(app.clone(), &entry);
        let result = updates::run(&api, &files, huggingface::HUB, &entry, &unit, &cancel, hooks).await;
        let Some(state) = app.try_state::<CatalogState>() else { return };
        state.operations().remove(&(entry.engine, entry.id.clone()));
        match result {
            Ok(resolved) => {
                log::info!("[model update] {} is now at {}", entry.id, resolved.commit);
                state.history().forget(entry.engine, &entry.id);
            }
            Err(error) if error.to_string() == updates::CANCELLED => log::info!("[model update] {} cancelled", entry.id),
            Err(error) => {
                log::error!("[model update] {} failed: {error}", entry.id);
                state.history().update_failures.push(UpdateFailure {
                    engine: entry.engine,
                    id: entry.id.clone(),
                    message: error.to_string(),
                });
            }
        }
        state.save();
        emit(&app);
    });
    Ok(state.status())
}

pub fn cancel_update<R: Runtime>(app: &AppHandle<R>, engine: Engine, id: &str) -> Result<Status, String> {
    let state = app.try_state::<CatalogState>().ok_or("The model list is still loading")?;
    if let Some(operation) = state.operations().get(&(engine, id.to_string())) {
        operation.cancel.cancel();
    }
    Ok(state.status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_catalog::{built_in, testing::use_catalog};

    fn document(count: usize) -> Vec<u8> {
        let models: Vec<_> = built_in().entries.iter().take(count).cloned().collect();
        serde_json::json!({ "schema": 1, "models": models }).to_string().into_bytes()
    }

    fn state(dir: &Path) -> CatalogState {
        CatalogState {
            dir: dir.to_path_buf(),
            history: Mutex::new(History::default()),
            checking: AtomicBool::new(false),
            running: tokio::sync::Mutex::new(()),
            operations: Mutex::new(HashMap::new()),
        }
    }

    /// Installs a Whisper model `id` at `commit`, as a finished download would.
    fn install_whisper(models_root: &Path, entry: &Entry, content: &[u8], commit: &str) {
        let unit = Unit::of(models_root, entry);
        std::fs::write(unit.path(&unit.files[0]), content).unwrap();
        let record = super::super::installed::InstallRecord {
            id: entry.id.clone(),
            repo: entry.repo.clone(),
            commit: commit.to_string(),
            complete: true,
            files: vec![super::super::installed::RecordFile {
                name: unit.files[0].clone(),
                size: content.len() as u64,
                sha256: crate::model_integrity::testing::pin_of("ggml.bin", content).sha256.to_string(),
                git_oid: None,
            }],
        };
        super::super::installed::write_record(&unit.record_path, &record).unwrap();
    }

    #[test]
    fn the_fetched_catalog_is_used_and_kept_and_a_failure_changes_nothing() {
        let _catalog = use_catalog((*built_in()).clone());
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(apply_fetch(dir.path(), Ok(document(3))), Ok(true));
        assert_eq!(crate::model_catalog::active().entries.len(), 3);
        assert_eq!(crate::model_catalog::source(), Source::Remote);
        assert_eq!(remote::startup(dir.path(), built_in()).1, Source::Cache);
        assert_eq!(apply_fetch(dir.path(), Ok(document(3))), Ok(false));

        // Unreachable, unreadable or empty: the catalog in use and the cache stay.
        let offline = FetchError { message: "offline".to_string(), transient: true };
        assert_eq!(apply_fetch(dir.path(), Err(offline.clone())), Err(offline));
        // An unusable document is GitHub's answer, not a reason to ask again soon.
        assert!(!apply_fetch(dir.path(), Ok(b"<html>".to_vec())).unwrap_err().transient);
        assert!(apply_fetch(dir.path(), Ok(document(0))).unwrap_err().message.contains("no list of models"));
        assert_eq!(crate::model_catalog::active().entries.len(), 3);
        assert_eq!(remote::startup(dir.path(), built_in()).0.entries.len(), 3);
    }

    #[test]
    fn checks_follow_the_updater_schedule() {
        let mut history = History::default();
        assert!(schedule::is_due(&history.schedule(true), 1_000));
        assert!(!schedule::is_due(&history.schedule(false), 1_000));

        history.record(false, false, Some("offline".to_string()), 1_000);
        assert_eq!((history.failures, history.error.as_deref()), (1, Some("offline")));
        history.record(true, false, Some("offline".to_string()), 2_000);
        assert_eq!(history.failures, 1);
        history.record(false, true, None, 3_000);
        assert_eq!((history.failures, history.last_checked_at, history.error.clone()), (0, Some(3_000), None));
        assert!(!schedule::is_due(&history.schedule(true), 3_000 + schedule::CHECK_INTERVAL_MS - 1));
        assert!(schedule::is_due(&history.schedule(true), 3_000 + schedule::CHECK_INTERVAL_MS));
        // GitHub answered 404: the check completed, the next one is a day later,
        // and the answer is shown.
        let answered = Some("GitHub answered 404 Not Found for the model list".to_string());
        history.record(false, true, answered.clone(), 5_000);
        assert_eq!((history.failures, history.last_checked_at, history.error.clone()), (0, Some(5_000), answered));
        assert!(!schedule::is_due(&history.schedule(true), 5_000 + schedule::CHECK_INTERVAL_MS - 1));
    }

    #[tokio::test]
    async fn a_model_hugging_face_answered_an_error_for_is_shown_and_does_not_fail_the_check() {
        use crate::model_catalog::testing::{entry_for, Hub};
        const OLD: &str = "1111111111111111111111111111111111111111";
        const NEW: &str = "2222222222222222222222222222222222222222";
        let tiny = entry_for(Engine::Whisper, "tiny", "owner/whisper");
        let gone = entry_for(Engine::Whisper, "base", "owner/gone");
        let _catalog = use_catalog(super::super::schema::Catalog { entries: vec![tiny.clone(), gone.clone()], hidden: Vec::new() });
        let dir = tempfile::tempdir().unwrap();
        install_whisper(dir.path(), &tiny, b"old tiny", OLD);
        install_whisper(dir.path(), &gone, b"old base", OLD);
        let mut hub = Hub::new();
        hub.repo("owner/whisper", NEW).lfs_file("ggml-tiny.bin", b"new tiny");
        let hub = hub.serve().await;
        let state = state(dir.path());

        // owner/gone is not on the hub: an answer about that one model.
        assert_eq!(check_installed(&state, dir.path(), &hub.url).await, Ok(()));
        let history = state.history().clone();
        assert_eq!(history.updates.iter().map(|update| update.id.as_str()).collect::<Vec<_>>(), ["tiny"]);
        assert_eq!(history.check_failures.len(), 1);
        assert_eq!(history.check_failures[0].id, "base");
        assert!(history.check_failures[0].message.contains("was not found on Hugging Face"), "{:?}", history.check_failures);

        // Hugging Face cannot be asked: the check fails and keeps what it knew.
        let error = check_installed(&state, dir.path(), "http://127.0.0.1:9").await.unwrap_err();
        assert!(error.contains("Couldn't reach Hugging Face") && error.contains("(and 1 more)"), "{error}");
        assert_eq!(*state.history(), history);
    }

    #[test]
    fn installed_models_are_found_by_id_and_file() {
        let _catalog = use_catalog((*built_in()).clone());
        let dir = tempfile::tempdir().unwrap();
        assert!(installed_units(dir.path()).is_empty());
        // A 0.3.x install: the file, no record. The size is not checked here.
        std::fs::write(dir.path().join("ggml-tiny.bin"), b"ggml").unwrap();
        std::fs::create_dir_all(dir.path().join("summary")).unwrap();
        std::fs::write(dir.path().join("summary").join("gemma-3-1b-it-Q8_0.gguf"), b"GGUF").unwrap();
        let ids: Vec<String> = installed_units(dir.path()).into_iter().map(|(entry, _)| entry.id).collect();
        assert_eq!(ids, ["tiny", "gemma3:1b"]);
    }
}
