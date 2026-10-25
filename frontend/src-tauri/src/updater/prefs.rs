//! Persisted updater settings and check history, in the plugin store
//! `updater.json` (Tauri's app data folder, next to `onboarding-status.json`).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

const STORE: &str = "updater.json";
const KEY: &str = "prefs";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// Daily background checks (Settings › About). On by default.
    pub auto_check: bool,
    /// Unix ms of the last check that reached a conclusion (including "no
    /// release yet"); the next automatic check is due 24 h later.
    pub last_checked_at: Option<i64>,
    /// Unix ms of the last check attempt, successful or not.
    pub last_attempt_at: Option<i64>,
    /// Failed checks since the last completed one; drives the backoff.
    pub failures: u32,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            auto_check: true,
            last_checked_at: None,
            last_attempt_at: None,
            failures: 0,
        }
    }
}

impl Prefs {
    pub fn record_check(&mut self, completed: bool, now: i64) {
        self.last_attempt_at = Some(now);
        if completed {
            self.last_checked_at = Some(now);
            self.failures = 0;
        } else {
            self.failures = self.failures.saturating_add(1);
        }
    }
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Prefs {
    let Ok(store) = app.store(STORE) else {
        log::warn!("[updater] settings store unavailable; using defaults");
        return Prefs::default();
    };
    store
        .get(KEY)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

pub fn save<R: Runtime>(app: &AppHandle<R>, prefs: &Prefs) -> Result<(), String> {
    let store = app.store(STORE).map_err(|error| error.to_string())?;
    store.set(KEY, serde_json::to_value(prefs).map_err(|error| error.to_string())?);
    store.save().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_are_on_by_default_and_missing_fields_keep_defaults() {
        let prefs: Prefs = serde_json::from_str(r#"{ "failures": 2 }"#).unwrap();
        assert!(prefs.auto_check);
        assert_eq!(prefs.failures, 2);
        assert_eq!(Prefs::default().last_checked_at, None);
    }

    #[test]
    fn a_completed_check_resets_the_failures() {
        let mut prefs = Prefs::default();
        prefs.record_check(false, 10);
        prefs.record_check(false, 20);
        assert_eq!((prefs.failures, prefs.last_attempt_at, prefs.last_checked_at), (2, Some(20), None));
        prefs.record_check(true, 30);
        assert_eq!((prefs.failures, prefs.last_attempt_at, prefs.last_checked_at), (0, Some(30), Some(30)));
    }
}
