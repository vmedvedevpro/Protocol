//! In-app updates from this repository's GitHub releases.
//!
//! Ownership: native code owns the whole lifecycle; the WebView only renders
//! the [`Snapshot`] pushed as `updater-status` and calls the commands in
//! `commands.rs`. It has no `updater:*` permission, so nothing reaches the
//! plugin except through this module.
//!
//! Flow: a scheduler (`run_scheduler`) checks once a day while automatic
//! checks are on, or a user clicks Check for updates → a newer release becomes
//! the offer → the user clicks Download → the payload is downloaded, verified
//! against the minisign key in `tauri.conf.json` and kept in the update cache
//! → the user clicks Restart and update, or quits (see `install.rs`).
//!
//! Rules: one check or download at a time (`op`); downloads never compete
//! with a recording (one requested during a recording waits for it to end, one
//! running when a recording starts is cancelled and restarts afterwards);
//! nothing installs while `busy::current()` reports work. A downloaded update
//! survives restarts: the cache is restored at launch without a request.

pub mod busy;
pub mod cache;
pub mod commands;
#[cfg(feature = "updater-e2e")]
mod e2e;
pub mod engine;
pub mod install;
pub mod journal;
pub mod prefs;
pub mod schedule;
pub mod status;
pub mod support;

use busy::BusyReason;
use cache::{AttemptOutcome, Cache};
use engine::DownloadEnd;
use prefs::Prefs;
use serde::Serialize;
use status::{Activity, CheckOutcome, ErrorKind, Machine, Offer, UpdateError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use support::Support;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::Update;
use tokio_util::sync::CancellationToken;

pub const STATUS_EVENT: &str = "updater-status";

/// How often the scheduler looks at busy state, a queued download and a
/// recording that started mid-download. Due checks are evaluated on the
/// slower `schedule::TICK`.
const WATCH: Duration = Duration::from_secs(3);
/// A manual check that waited for a running check reuses its result.
const JOIN_WINDOW_MS: i64 = 5_000;

/// Set by the first quit request, so the exit that follows an install on
/// quit (or a refused one) is not intercepted again.
static QUITTING: AtomicBool = AtomicBool::new(false);

pub struct UpdaterState {
    support: Support,
    current_version: String,
    cache: Cache,
    machine: Mutex<Machine>,
    prefs: Mutex<Prefs>,
    /// One check or download at a time.
    op: tokio::sync::Mutex<()>,
    /// The plugin's `Update` behind the current offer: from the last check, or
    /// rebuilt from the cache at launch.
    pending: Mutex<Option<Update>>,
    download_cancel: Mutex<Option<CancellationToken>>,
    /// Set when this launch is the result of an install (for the "Updated" toast).
    updated_from: Mutex<Option<String>>,
    busy: Mutex<Vec<BusyReason>>,
    /// What the tray menu last showed, so it is rebuilt only when that changes.
    tray_item: Mutex<TrayItem>,
}

/// The updater's line in the tray menu.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum TrayItem {
    #[default]
    None,
    /// A newer release is offered and not downloaded (or a `.deb` notice).
    Available(String),
    Downloading,
    /// Downloaded; `busy` disables the item.
    Ready { version: String, busy: bool },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub current_version: String,
    pub platform: &'static str,
    pub support: Support,
    pub auto_check: bool,
    pub last_checked_at: Option<i64>,
    pub activity: Activity,
    pub offer: Option<Offer>,
    pub error: Option<UpdateError>,
    pub busy_reasons: Vec<BusyReason>,
    pub updated_from: Option<String>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl UpdaterState {
    fn new(support: Support, current_version: String, cache: Cache, prefs: Prefs) -> Self {
        Self {
            machine: Mutex::new(Machine::new(matches!(support, Support::ManualOnly { .. }))),
            support,
            current_version,
            cache,
            prefs: Mutex::new(prefs),
            op: tokio::sync::Mutex::new(()),
            pending: Mutex::new(None),
            download_cancel: Mutex::new(None),
            updated_from: Mutex::new(None),
            busy: Mutex::new(Vec::new()),
            tray_item: Mutex::new(TrayItem::None),
        }
    }

    pub fn tray_item(&self) -> TrayItem {
        let machine = self.machine();
        let busy = self.busy.lock().map(|busy| !busy.is_empty()).unwrap_or(true);
        match (&machine.activity, &machine.offer) {
            (Activity::Downloading { .. }, _) => TrayItem::Downloading,
            (_, Some(offer)) if offer.downloaded => TrayItem::Ready {
                version: offer.release.version.clone(),
                busy: busy || machine.activity != Activity::Idle,
            },
            (_, Some(offer)) => TrayItem::Available(offer.release.version.clone()),
            _ => TrayItem::None,
        }
    }

    pub fn support(&self) -> Support {
        self.support
    }

    fn machine(&self) -> std::sync::MutexGuard<'_, Machine> {
        self.machine.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn prefs(&self) -> std::sync::MutexGuard<'_, Prefs> {
        self.prefs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn journal(&self, line: &str) {
        journal::record(self.cache.dir(), line);
    }

    pub fn snapshot(&self) -> Snapshot {
        let machine = self.machine().clone();
        let prefs = self.prefs().clone();
        Snapshot {
            current_version: self.current_version.clone(),
            platform: support::platform(),
            support: self.support,
            auto_check: prefs.auto_check,
            last_checked_at: prefs.last_checked_at,
            activity: machine.activity,
            offer: machine.offer,
            error: machine.error,
            busy_reasons: self.busy.lock().map(|busy| busy.clone()).unwrap_or_default(),
            updated_from: self.updated_from.lock().ok().and_then(|from| from.clone()),
        }
    }

    pub fn ready_version(&self) -> Option<String> {
        self.machine().ready_version().map(str::to_string)
    }

    fn save_prefs(&self, app: &AppHandle<impl Runtime>) {
        let prefs = self.prefs().clone();
        if let Err(error) = prefs::save(app, &prefs) {
            log::warn!("[updater] could not save settings: {error}");
        }
    }

    /// Re-reads busy state; true when it changed.
    fn refresh_busy(&self) -> bool {
        let now = busy::current();
        let Ok(mut busy) = self.busy.lock() else { return false };
        if *busy == now {
            return false;
        }
        *busy = now;
        true
    }
}

/// Registers the updater state and starts the scheduler. Call at the end of
/// `.setup`, after the database, so onboarding and paths are available.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let support = support::detect();
    let current_version = app.package_info().version.to_string();
    let cache_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| crate::paths::install_data_root().join("cache"))
        .join("updates");
    let prefs = prefs::load(app);
    let state = UpdaterState::new(support, current_version, Cache::new(cache_dir), prefs);
    state.journal(&format!("start {} {:?}", state.current_version, support));
    app.manage(state);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_scheduler(app).await;
    });
}

pub fn emit_status<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<UpdaterState>() else { return };
    let snapshot = state.snapshot();
    if let Err(error) = app.emit(STATUS_EVENT, &snapshot) {
        log::warn!("[updater] could not push the status: {error}");
    }
    let item = state.tray_item();
    let changed = state
        .tray_item
        .lock()
        .map(|mut shown| std::mem::replace(&mut *shown, item.clone()) != item)
        .unwrap_or(false);
    if changed {
        crate::tray::update_tray_menu(app);
    }
}

pub fn is_quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

/// Whether quitting now would try to install a downloaded update.
pub fn installs_on_quit<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<UpdaterState>()
        .is_some_and(|state| state.support.installs() && state.ready_version().is_some())
}

/// Tray Quit and macOS ⌘Q / Dock Quit. With a downloaded update and nothing
/// busy, the update installs and the app exits without starting again (the
/// next start runs the new version); otherwise the app quits as before. A
/// quit during a recording keeps today's behaviour and never installs (#32).
pub fn quit_app<R: Runtime>(app: &AppHandle<R>) {
    if QUITTING.swap(true, Ordering::SeqCst) || !installs_on_quit(app) {
        app.exit(0);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(refusal) = install::install_now(&app, install::Mode::Quit, &[]).await {
            log::info!("[updater] quitting without installing: {refusal:?}");
            app.exit(0);
        }
    });
}

/// "Restart and update" from the panel, Settings or the tray. `Failed` means
/// the install was attempted and the snapshot carries its error.
pub async fn install_and_restart<R: Runtime>(app: &AppHandle<R>) -> Result<(), install::Refusal> {
    let result = install::install_now(app, install::Mode::Restart, &[]).await;
    if matches!(result, Err(install::Refusal::Busy { .. })) {
        app.state::<UpdaterState>().refresh_busy();
        emit_status(app);
    }
    result
}

/// Reads the onboarding status into the busy registry: no update installs
/// and no automatic check runs before setup is finished.
pub async fn refresh_onboarding<R: Runtime>(app: &AppHandle<R>) {
    let complete = crate::onboarding::load_onboarding_status(app)
        .await
        .map(|status| status.completed)
        .unwrap_or(false);
    busy::set_onboarding_complete(complete);
}

/// Launch-time bookkeeping: the install-attempt marker and a cached download.
/// Holds `op` throughout, so a check clicked meanwhile runs afterwards and its
/// result is not overwritten by the cached offer.
async fn restore<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<UpdaterState>();
    let _op = state.op.lock().await;
    if let Some(attempt) = state.cache.take_attempt() {
        match cache::attempt_outcome(&attempt, &state.current_version) {
            AttemptOutcome::Updated { from } => {
                state.journal(&format!("install {from} -> {} succeeded", state.current_version));
                state.cache.remove_except(None);
                if let Ok(mut updated) = state.updated_from.lock() {
                    *updated = Some(from);
                }
            }
            AttemptOutcome::Incomplete { to } => {
                state.journal(&format!("install {} -> {to} did not finish", state.current_version));
                state.machine().install_incomplete(&to, now_ms());
            }
            AttemptOutcome::Unrelated => {}
        }
    }

    if !state.support.installs() {
        state.cache.remove_except(None);
        return;
    }
    let Some(entry) = state.cache.entries().into_iter().next() else { return };
    let updater = match engine::updater(app, state.support) {
        Ok(updater) => updater,
        Err((_, message)) => {
            log::warn!("[updater] cannot restore the cached update: {message}");
            return;
        }
    };
    // `restore_update` applies the version comparator, so a cached version
    // that is not newer than this one comes back as None and is deleted.
    let update = match updater.restore_update(entry.raw_json.clone()) {
        Ok(Some(update)) if update.version == entry.version => update,
        Ok(_) => {
            state.cache.remove_except(None);
            return;
        }
        Err(error) => {
            state.journal(&format!("cached {} rejected: {error}", entry.version));
            state.cache.remove_except(None);
            return;
        }
    };
    let verified = {
        let update = update.clone();
        let cache = Cache::new(state.cache.dir().to_path_buf());
        let entry = entry.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let bytes = cache.read_payload(&entry).map_err(|error| error.to_string())?;
            update.verify(&bytes).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result)
    };
    match verified {
        Ok(()) => {
            state.journal(&format!("restored downloaded {}", entry.version));
            state.machine().restore(engine::release_of(&update));
            if let Ok(mut pending) = state.pending.lock() {
                *pending = Some(update);
            }
        }
        Err(error) => {
            state.journal(&format!("cached {} failed verification: {error}", entry.version));
            state.cache.remove_except(None);
        }
    }
}

/// Runs a check and returns the resulting snapshot. A manual check bypasses
/// the schedule and the switch; one that finds a check already running waits
/// for it and reports its result instead of asking GitHub twice.
pub async fn check_now<R: Runtime>(app: &AppHandle<R>, manual: bool) -> Snapshot {
    let state = app.state::<UpdaterState>();
    if !state.support.checks() {
        return state.snapshot();
    }
    if matches!(state.machine().activity, Activity::Downloading { .. } | Activity::Installing) {
        return state.snapshot();
    }
    let started = now_ms();
    let _op = state.op.lock().await;
    let joined = state.prefs().last_attempt_at.is_some_and(|at| at >= started - JOIN_WINDOW_MS);
    if manual && joined {
        return state.snapshot();
    }
    if !state.machine().begin_check(manual) {
        return state.snapshot();
    }
    emit_status(app);
    state.journal(if manual { "check (manual)" } else { "check (automatic)" });

    let outcome = match engine::updater(app, state.support) {
        Err((kind, message)) => CheckOutcome::Failed(kind, message),
        Ok(updater) => match engine::check(&updater).await {
            Ok(None) => CheckOutcome::UpToDate,
            Ok(Some(update)) => {
                let release = engine::release_of(&update);
                if let Ok(mut pending) = state.pending.lock() {
                    *pending = Some(update);
                }
                CheckOutcome::Found(release)
            }
            Err((kind, message)) => CheckOutcome::Failed(kind, message),
        },
    };
    state.journal(&match &outcome {
        CheckOutcome::UpToDate => "check: up to date".to_string(),
        CheckOutcome::Found(release) => format!("check: {} available", release.version),
        CheckOutcome::Failed(kind, message) => format!("check failed ({kind:?}): {message}"),
    });

    let now = now_ms();
    let effect = state.machine().finish_check(manual, outcome, now);
    if effect.drop_download {
        state.cache.remove_except(None);
    }
    if state.machine().offer.is_none() {
        if let Ok(mut pending) = state.pending.lock() {
            *pending = None;
        }
    }
    state.prefs().record_check(manual, effect.completed, now);
    state.save_prefs(app);
    emit_status(app);
    state.snapshot()
}

/// The user clicked Download. Starts the download in the background, or
/// queues it until the running recording ends.
pub fn request_download<R: Runtime>(app: &AppHandle<R>) -> Snapshot {
    let state = app.state::<UpdaterState>();
    let recording = crate::audio::recording_commands::is_recording_active();
    let start = state.machine().request_download(recording);
    if start {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { download(&app).await });
    } else if recording {
        state.journal("download queued until the recording ends");
        emit_status(app);
    }
    state.snapshot()
}

async fn download<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<UpdaterState>();
    let _op = state.op.lock().await;
    let Some(version) = state.machine().begin_download() else { return };
    let update = state.pending.lock().ok().and_then(|pending| pending.clone());
    let Some(update) = update.filter(|update| update.version == version) else {
        state.machine().finish_download(
            &version,
            Err((ErrorKind::Download, "the release is no longer known; check again".into())),
            now_ms(),
        );
        emit_status(app);
        return;
    };
    let cancel = CancellationToken::new();
    if let Ok(mut slot) = state.download_cancel.lock() {
        *slot = Some(cancel.clone());
    }
    state.journal(&format!("download {version} started"));
    emit_status(app);

    let free = engine::free_space(state.cache.dir());
    let end = engine::download(&update, cancel, free, |received, total| {
        state.machine().download_progress(received, total);
        emit_status(app);
    })
    .await;
    if let Ok(mut slot) = state.download_cancel.lock() {
        *slot = None;
    }

    let now = now_ms();
    match end {
        DownloadEnd::Done(bytes) => {
            let stored = state.cache.store(&version, update.raw_json.clone(), &bytes, now);
            drop(bytes);
            match stored {
                Ok(_) => {
                    state.journal(&format!("download {version} verified and cached"));
                    state.machine().finish_download(&version, Ok(()), now);
                }
                Err(error) => {
                    state.journal(&format!("download {version} could not be cached: {error}"));
                    let kind = if error.kind() == std::io::ErrorKind::StorageFull {
                        ErrorKind::DiskSpace
                    } else {
                        ErrorKind::Download
                    };
                    state.machine().finish_download(&version, Err((kind, error.to_string())), now);
                }
            }
        }
        DownloadEnd::Cancelled => {
            state.journal(&format!("download {version} paused for a recording"));
            state.machine().download_interrupted(&version);
        }
        DownloadEnd::Failed((kind, message)) => {
            state.journal(&format!("download {version} failed ({kind:?}): {message}"));
            state.machine().finish_download(&version, Err((kind, message)), now);
        }
    }
    emit_status(app);
}

pub fn set_auto_check<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Snapshot {
    let state = app.state::<UpdaterState>();
    state.prefs().auto_check = enabled;
    state.save_prefs(app);
    state.journal(if enabled { "automatic checks on" } else { "automatic checks off" });
    emit_status(app);
    state.snapshot()
}

/// The background loop: restore at launch, then watch busy state and
/// recordings every few seconds and run due checks on the schedule.
async fn run_scheduler<R: Runtime>(app: AppHandle<R>) {
    refresh_onboarding(&app).await;
    restore(&app).await;
    #[cfg(feature = "updater-e2e")]
    if let Some(result) = e2e::result_path() {
        e2e::run(&app, &result).await;
        return;
    }
    {
        let state = app.state::<UpdaterState>();
        state.refresh_busy();
    }
    emit_status(&app);

    let started = Instant::now();
    let mut first_tick_done = false;
    let mut last_tick = Instant::now();
    loop {
        tokio::time::sleep(WATCH).await;
        let state = app.state::<UpdaterState>();
        let recording = crate::audio::recording_commands::is_recording_active();

        // A recording started mid-download: cancel; it restarts afterwards.
        if recording {
            if let Some(cancel) = state.download_cancel.lock().ok().and_then(|slot| slot.clone()) {
                cancel.cancel();
            }
        }
        if state.machine().take_pending_download(recording) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { download(&app).await });
        }
        if state.refresh_busy() {
            emit_status(&app);
        }

        let tick_due = if first_tick_done {
            last_tick.elapsed() >= schedule::TICK
        } else {
            started.elapsed() >= schedule::FIRST_TICK
        };
        if !tick_due {
            continue;
        }
        last_tick = Instant::now();
        if !first_tick_done {
            first_tick_done = true;
            #[cfg(windows)]
            {
                let removed = cache::remove_installer_temp_dirs(&std::env::temp_dir(), &app.package_info().name);
                if removed > 0 {
                    state.journal(&format!("removed {removed} leftover installer folder(s)"));
                }
            }
        }

        refresh_onboarding(&app).await;
        let now = now_ms();
        let due = {
            let mut prefs = state.prefs();
            let normalized = schedule::normalize(&mut prefs, now);
            let due = schedule::is_due(&prefs, now);
            drop(prefs);
            if normalized {
                state.save_prefs(&app);
            }
            due
        };
        if due && state.support.checks() && busy::onboarding_complete() {
            check_now(&app, false).await;
        }
    }
}
