//! Keeps the catalog in use current: the cached copy at launch, then the file
//! on `main` once a day while "Check for updates automatically" is on (the
//! updater's scheduler calls [`tick`]), or when the user clicks Check for
//! model updates. Each change is pushed to the WebView as
//! [`CHANGED_EVENT`]; Settings then lists the models again.
//!
//! The history (last check, failures, last error) is kept beside the cached
//! catalog, so restarts follow the same 24 h schedule and backoff as app
//! updates (`crate::updater::schedule`).

use super::remote::{self, Source};
use super::schema::Hidden;
use crate::updater::prefs::Prefs;
use crate::updater::{now_ms, schedule};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const CHANGED_EVENT: &str = "model-catalog-changed";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct History {
    /// Unix ms of the last check that reached GitHub and read the file.
    last_checked_at: Option<i64>,
    last_attempt_at: Option<i64>,
    /// Failed automatic checks since the last completed one.
    failures: u32,
    /// When the catalog in use was fetched, if it came from `main`.
    fetched_at: Option<i64>,
    /// Why the last check did not complete.
    error: Option<String>,
}

impl History {
    fn record(&mut self, manual: bool, result: &Result<(), String>, now: i64) {
        // The updater's rule: a completed check resets the failures, a failed
        // manual one does not count.
        let mut prefs = self.schedule(true);
        prefs.record_check(manual, result.is_ok(), now);
        self.last_checked_at = prefs.last_checked_at;
        self.last_attempt_at = prefs.last_attempt_at;
        self.failures = prefs.failures;
        self.error = result.clone().err();
    }

    fn schedule(&self, auto_check: bool) -> Prefs {
        Prefs {
            auto_check,
            last_checked_at: self.last_checked_at,
            last_attempt_at: self.last_attempt_at,
            failures: self.failures,
        }
    }
}

/// What Settings shows about the catalog.
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
}

pub struct CatalogState {
    dir: PathBuf,
    history: Mutex<History>,
    checking: AtomicBool,
    /// One check at a time; a second one waits and then runs.
    running: tokio::sync::Mutex<()>,
}

impl CatalogState {
    fn history(&self) -> std::sync::MutexGuard<'_, History> {
        self.history.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn status(&self) -> Status {
        let history = self.history().clone();
        Status {
            source: super::source(),
            fetched_at: history.fetched_at,
            last_checked_at: history.last_checked_at,
            checking: self.checking.load(Ordering::Acquire),
            error: history.error,
            hidden: super::active().hidden.clone(),
        }
    }

    fn save(&self) {
        let history = self.history().clone();
        let path = history_file(&self.dir);
        let result = std::fs::create_dir_all(&self.dir)
            .and_then(|()| std::fs::write(&path, serde_json::to_vec_pretty(&history).unwrap_or_default()));
        if let Err(error) = result {
            log::warn!("[model catalog] could not save {}: {error}", path.display());
        }
    }
}

fn history_file(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

/// Puts the cached catalog in use and registers the state. Call before the
/// engines list their models.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| crate::paths::install_data_root().join("cache"))
        .join("model-catalog");
    let (catalog, source) = remote::startup(&dir, super::built_in());
    log::info!("[model catalog] {} models from {:?}", catalog.entries.len(), source);
    super::set_active(catalog, source);
    let history = std::fs::read(history_file(&dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    app.manage(CatalogState {
        dir,
        history: Mutex::new(history),
        checking: AtomicBool::new(false),
        running: tokio::sync::Mutex::new(()),
    });
}

/// Applies a fetched document: one that can be used becomes the catalog in
/// use and the cached copy; anything else leaves both as they are. Returns
/// whether the models offered changed.
fn apply_fetch(dir: &Path, fetched: Result<Vec<u8>, String>) -> Result<bool, String> {
    let bytes = fetched?;
    let catalog = remote::usable(&bytes).map_err(|error| error.to_string())?;
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

/// Fetches the catalog from `main` and puts it in use.
pub async fn check<R: Runtime>(app: &AppHandle<R>, manual: bool) -> Result<Status, String> {
    let state = app.try_state::<CatalogState>().ok_or("The model list is still loading")?;
    let _running = state.running.lock().await;
    state.checking.store(true, Ordering::Release);
    emit(app);

    let fetched = remote::fetch(&super::huggingface::client(), remote::CATALOG_URL).await;
    let now = now_ms();
    let result = apply_fetch(&state.dir, fetched);
    match &result {
        Ok(changed) => {
            log::info!("[model catalog] fetched from main ({})", if *changed { "changed" } else { "unchanged" });
            state.history().fetched_at = Some(now);
        }
        Err(error) => log::warn!("[model catalog] check failed; keeping the {:?} list: {error}", super::source()),
    }
    state.history().record(manual, &result.map(|_| ()), now);
    state.save();
    state.checking.store(false, Ordering::Release);
    emit(app);
    Ok(state.status())
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
    if due && crate::updater::busy::onboarding_complete() {
        let _ = check(app, false).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_catalog::{built_in, testing::use_catalog};

    fn document(count: usize) -> Vec<u8> {
        let models: Vec<_> = built_in().entries.iter().take(count).cloned().collect();
        serde_json::json!({ "schema": 1, "models": models }).to_string().into_bytes()
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
        assert!(apply_fetch(dir.path(), Err("offline".to_string())).is_err());
        assert!(apply_fetch(dir.path(), Ok(b"<html>".to_vec())).is_err());
        assert!(apply_fetch(dir.path(), Ok(document(0))).unwrap_err().contains("no list of models"));
        assert_eq!(crate::model_catalog::active().entries.len(), 3);
        assert_eq!(remote::startup(dir.path(), built_in()).0.entries.len(), 3);
    }

    #[test]
    fn checks_follow_the_updater_schedule() {
        let mut history = History::default();
        assert!(schedule::is_due(&history.schedule(true), 1_000));
        assert!(!schedule::is_due(&history.schedule(false), 1_000));

        history.record(false, &Err("offline".to_string()), 1_000);
        assert_eq!((history.failures, history.error.as_deref()), (1, Some("offline")));
        history.record(true, &Err("offline".to_string()), 2_000);
        assert_eq!(history.failures, 1);
        history.record(false, &Ok(()), 3_000);
        assert_eq!((history.failures, history.last_checked_at, history.error.clone()), (0, Some(3_000), None));
        assert!(!schedule::is_due(&history.schedule(true), 3_000 + schedule::CHECK_INTERVAL_MS - 1));
        assert!(schedule::is_due(&history.schedule(true), 3_000 + schedule::CHECK_INTERVAL_MS));
    }
}
