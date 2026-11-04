//! Whisper on an Intel GPU (#79): the OpenVINO companion of a Whisper model
//! and the OpenVINO GenAI runtime that runs it, which Settings installs
//! together with one click.
//!
//! A companion is an `openvino-ir` catalog entry naming the ggml models it
//! serves (`companion_of`) and its runtime (`runtime`, an entry of the
//! catalog's `runtimes`, installed by `super::runtime`). The ggml lists leave
//! it out (`super::usable`); #88 lists the one that serves the Compressed
//! copy as a Whisper model of its own, the Intel GPU version, chosen by its
//! id (`crate::speech_choice`), and Settings offers it saying what is
//! downloaded, from where and how big, so nothing is downloaded without the
//! person asking.
//!
//! On disk a companion is `<models>/openvino/<id>/` with its `install.json`
//! and a `.verified` marker beside each file. The download takes the same
//! steps as a Parakeet model's: the files are resolved at the entry's pinned
//! commit, the record is written incomplete before the first byte (so an
//! interrupted download resumes from that commit), every file is hashed as it
//! streams in against its pin and marked, and the record says complete only
//! once all of them matched. [`installed_companion`] trusts exactly that state.
//!
//! The runtime is `<data>/runtimes/openvino-genai/<version>/`. A process
//! loads at most one version, once (`whisper_engine::openvino::runtime`), and
//! a loaded library cannot be deleted on Windows. So a version installed
//! after another was loaded is used from the next start, and a version is
//! removed only when this process has not loaded it: right after an install
//! or a removal, and at the next start ([`prune_at_startup`]). The runtime
//! goes with the last companion that needs it, unless Parakeet on the Intel
//! NPU keeps it (#66: while Parakeet v3 is installed or downloading).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use super::installed::{self, InstallRecord};
use super::runtime::{self as runtimes, Installed};
use super::schema::{self, Entry, License, RuntimeEntry, OPENVINO_GENAI};
use super::{huggingface, sizes};
use crate::model_integrity::{self, Pinned};
use crate::updater::busy::{self, BusyReason};
use crate::whisper_engine::openvino::genai::API_LEVEL;

/// Sent when the state changes (a download's progress, its end, a removal, a
/// size read from Hugging Face); Settings asks for the status again. It also
/// listens to `model-catalog-changed`, which can bring another runtime.
pub const CHANGED_EVENT: &str = "openvino-companion-changed";

pub use super::runtime::CANCELLED;

/// How often a running download reports its progress.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

/// A stalled transfer fails after this long without a byte, like the other
/// model downloads.
const STALL: Duration = Duration::from_secs(30);

/// The companion that serves the Whisper model `whisper_model_id`, if the
/// catalog has one this build can run.
pub fn companion_for(whisper_model_id: &str) -> Option<Entry> {
    super::companions()
        .into_iter()
        .find(|entry| entry.companion_of.iter().any(|id| id == whisper_model_id))
}

fn companion(id: &str) -> Option<Entry> {
    super::companions().into_iter().find(|entry| entry.id == id)
}

/// Where the companion `entry` is kept under `models_dir`.
pub fn dir_in(models_dir: &Path, entry: &Entry) -> PathBuf {
    models_dir.join("openvino").join(&entry.id)
}

/// The companion's folder when its download completed and every file still
/// has a valid verification marker: two metadata reads and a small file read
/// per file, no hashing. A file changed since its check loses its marker and
/// the companion then counts as not installed until a download checks it
/// again (which re-hashes the file instead of fetching it anew).
fn verified_in(models_dir: &Path, entry: &Entry) -> Option<PathBuf> {
    let dir = dir_in(models_dir, entry);
    let expected = installed::expected(entry, &installed::record_path_for_dir(&dir))?;
    expected
        .files
        .iter()
        .all(|pinned| model_integrity::is_marked(pinned, &dir.join(pinned.file)))
        .then_some(dir)
}

/// An installed companion: its folder and the commit it was downloaded at,
/// which keys OpenVINO's model cache with the runtime version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledCompanion {
    pub dir: PathBuf,
    pub commit: String,
}

fn installed_in(models_dir: &Path, entry: &Entry) -> Option<InstalledCompanion> {
    let dir = verified_in(models_dir, entry)?;
    let commit = installed::read_record(&installed::record_path_for_dir(&dir))?.commit;
    Some(InstalledCompanion { dir, commit })
}

/// The installed and verified companion of the Whisper model
/// `whisper_model_id`, or `None`. Cheap and offline (see [`verified_in`]), so
/// the engine can ask on every model load.
pub fn installed_companion(whisper_model_id: &str) -> Option<InstalledCompanion> {
    installed_in(&crate::paths::models_dir(), &companion_for(whisper_model_id)?)
}

/// The commits of every installed companion: the model half of the cache
/// keys still in use.
pub fn installed_commits() -> Vec<String> {
    let models = crate::paths::models_dir();
    super::companions().iter().filter_map(|entry| installed_in(&models, entry)).map(|installed| installed.commit).collect()
}

/// Left in a companion's folder by the download that installed the runtime
/// for it, until the companion is installed or removed: the runtime then
/// stays when the companion's part fails or is cancelled before it has a
/// record, and the next click fetches only the companion.
const REQUESTED: &str = ".requested";

/// Whether a companion among `entries` is installed, has begun downloading
/// (it has a record) or was asked for with the runtime: what keeps the
/// runtime on disk.
fn any_companion_in(models_dir: &Path, entries: &[Entry]) -> bool {
    entries.iter().any(|entry| {
        let dir = dir_in(models_dir, entry);
        dir.join(REQUESTED).is_file() || installed::read_record(&installed::record_path_for_dir(&dir)).is_some()
    })
}

/// Whether a companion other than `entry` keeps the runtime, so that
/// removing `entry` leaves it installed.
fn others_keep_runtime(models_dir: &Path, entry: &Entry, companions: &[Entry]) -> bool {
    let others: Vec<Entry> = companions.iter().filter(|other| other.id != entry.id).cloned().collect();
    any_companion_in(models_dir, &others)
}

// --- The runtime ------------------------------------------------------------

fn runtime_root() -> PathBuf {
    runtimes::root_in(&crate::paths::install_data_root(), OPENVINO_GENAI)
}

/// The runtime entry this build would install now (`super::runtime`).
pub fn runtime_entry() -> Option<RuntimeEntry> {
    super::runtime(OPENVINO_GENAI, API_LEVEL)
}

/// Why this build cannot install the runtime the catalog lists, if it cannot.
fn refusal() -> String {
    let versions: Vec<String> = super::runtimes_out_of_reach(OPENVINO_GENAI, API_LEVEL)
        .into_iter()
        .map(|runtime| runtime.version)
        .collect();
    if versions.is_empty() {
        "The model list has no OpenVINO runtime for this computer.".to_string()
    } else {
        format!(
            "The model list offers OpenVINO GenAI {}, which this version of Protocol cannot run. Update Protocol to use it.",
            versions.join(", ")
        )
    }
}

/// The installed version to load from `root`, of this binding's API level:
/// the one `offered` names, else the newest one older than it (an update
/// not downloaded yet), never a newer one, so a catalog that steps back
/// retires a version it pinned before. Without an offer, the newest. An
/// error says why none can load, and is what Settings shows.
fn selected_in(root: &Path, offered: Option<&RuntimeEntry>) -> std::result::Result<Installed, String> {
    let installed = runtimes::installed_in(root);
    // Newest first, as `installed_in` sorts them.
    let usable: Vec<&Installed> = installed.iter().filter(|version| version.record.api == API_LEVEL).collect();
    let chosen = match offered {
        Some(offered) => {
            let ceiling = schema::runtime_version_key(&offered.version);
            usable.iter().find(|version| schema::runtime_version_key(&version.record.version) <= ceiling)
        }
        None => usable.first(),
    };
    if let Some(version) = chosen {
        return Ok((*version).clone());
    }
    match (offered, usable.first(), installed.first()) {
        (Some(offered), Some(withdrawn), _) => Err(format!(
            "the model list no longer offers OpenVINO GenAI {}; download {} in Settings › Transcription",
            withdrawn.record.version, offered.version
        )),
        (_, _, Some(other)) => Err(format!(
            "OpenVINO GenAI {} is installed, but this version of Protocol cannot run it (API level {}, this version runs level {API_LEVEL})",
            other.record.version, other.record.api
        )),
        _ => Err("the OpenVINO runtime is not installed".to_string()),
    }
}

/// The installed runtime version this process should load, or why there is
/// none. Cheap and offline: the engine asks on its first OpenVINO load.
pub fn runtime_to_load() -> std::result::Result<Installed, String> {
    selected_in(&runtime_root(), runtime_entry().as_ref())
}

/// Removes the runtime versions nothing will load: all but the selected one
/// and the one this process loaded, or all but the loaded one when no
/// companion needs the runtime any more. The engine's runtime slot is held
/// throughout, so no version starts loading from a folder being deleted.
/// Callers hold [`OPERATIONS`].
fn prune_runtimes(root: &Path, wanted: bool, offered: Option<&RuntimeEntry>) {
    crate::whisper_engine::openvino::with_runtime_slot(|loaded| {
        let mut keep: Vec<PathBuf> = loaded.map(Path::to_path_buf).into_iter().collect();
        if wanted {
            keep.extend(selected_in(root, offered).ok().map(|version| version.dir));
        }
        runtimes::prune_in(root, &keep);
    });
}

/// One install, removal or prune of the runtime and the companions at a
/// time: they share the runtime's folder, its staging folders and the
/// question whether a companion still needs it.
static OPERATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// At startup, before anything loads the runtime: removes runtime versions
/// an update replaced or the catalog withdrew, an install a crash cut short,
/// and the runtime and the model cache when no companion needs them. Call
/// once the catalog in use is set (`service::init`).
pub fn prune_at_startup() {
    // Nothing else runs this early; if something does, it prunes itself.
    let Ok(_operations) = OPERATIONS.try_lock() else { return };
    // Parakeet on the NPU keeps the runtime too (#66), not Whisper's cache.
    let companion = any_companion_in(&crate::paths::models_dir(), &super::companions());
    let wanted = companion || crate::parakeet_engine::npu::state::keeps_runtime();
    prune_runtimes(&runtime_root(), wanted, runtime_entry().as_ref());
    if !companion {
        crate::whisper_engine::openvino::remove_cache();
    }
    if !wanted {
        crate::parakeet_engine::npu::state::runtime_removed();
    }
}

// --- Status -----------------------------------------------------------------

/// The runtime as Settings describes it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub name: String,
    /// The version a download installs: the catalog's.
    pub version: String,
    pub license: License,
    /// The host the archive comes from.
    pub source: String,
    /// The archive's size.
    pub download_size: u64,
    /// What its files take once installed.
    pub installed_size: u64,
    /// The installed version that loads, if any.
    pub installed: Option<String>,
    /// The version used after a restart, when this process loaded another.
    pub after_restart: Option<String>,
    /// An installed version no companion needs any more, which the next
    /// start removes: it stayed because this process loaded it. It counts
    /// as not installed meanwhile; a download before that start keeps it.
    pub removed_at_restart: Option<String>,
}

/// What Settings shows for a companion and its runtime.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The Hugging Face repository it comes from.
    pub repo: String,
    pub companion_of: Vec<String>,
    /// Installed: its files; otherwise what a download fetches. `None` while
    /// unknown.
    pub size: Option<u64>,
    /// The companion's files are installed and verified.
    pub companion_installed: bool,
    /// The catalog's runtime (from the built-in list when the one in use has
    /// none this build can run).
    pub runtime: Option<RuntimeStatus>,
    /// Both are there: Whisper can run on OpenVINO from the next model load.
    pub installed: bool,
    /// What a click on Download fetches now, when every part's size is known.
    /// A runtime awaiting its removal at the next start
    /// (`RuntimeStatus::removed_at_restart`) is reused, not fetched: the
    /// click keeps it.
    pub download_size: Option<u64>,
    /// Why the runtime cannot be installed or loaded here.
    pub refused: Option<String>,
    /// The percentage of a running download.
    pub downloading: Option<u8>,
    /// The bytes of a running download: what it fetches, which is not
    /// `size` or `download_size` once a part is installed during it.
    pub progress: Option<Progress>,
    /// OpenVINO is off because the app closed unexpectedly inside it
    /// (`whisper_engine::openvino::stopped`); `openvino_retry` turns it on.
    pub stopped: Option<String>,
    /// `openvino_remove` would delete the installed runtime too: no other
    /// companion keeps it.
    pub removes_runtime: bool,
}

/// How far a running download got, over every part it fetches.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Bytes fetched, or found intact on disk, so far.
    pub done: u64,
    /// What this download fetches: the runtime's archive when its version
    /// is missing, plus the companion's files when they are. 0 until the
    /// first report.
    pub total: u64,
}

impl Progress {
    /// At most 99 until both are installed.
    fn percent(self) -> u8 {
        (self.done.saturating_mul(100) / self.total.max(1)).min(99) as u8
    }
}

/// A running download: its cancellation and how far it got.
struct Running {
    cancel: CancellationToken,
    progress: Progress,
}

/// Running downloads by companion id.
static DOWNLOADS: Lazy<Mutex<HashMap<String, Running>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn downloads() -> std::sync::MutexGuard<'static, HashMap<String, Running>> {
    DOWNLOADS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Records how far the running download of companion `id` got.
fn report(id: &str, progress: Progress) {
    if let Some(download) = downloads().get_mut(id) {
        download.progress = progress;
    }
}

/// The archive's host, for "from storage.openvinotoolkit.org".
fn host(url: &str) -> String {
    url.split("://").nth(1).and_then(|rest| rest.split('/').next()).unwrap_or_default().to_string()
}

/// The status of `entry` among `companions` (which decide whether the
/// runtime is still needed, with `npu_keeps`: Parakeet on the NPU keeps it,
/// #66), with `loaded` the runtime folder this process loaded.
fn status_in(
    models_dir: &Path,
    runtime_root: &Path,
    entry: &Entry,
    offered: Option<&RuntimeEntry>,
    loaded: Option<&Path>,
    companions: &[Entry],
    npu_keeps: bool,
) -> CompanionStatus {
    let dir = dir_in(models_dir, entry);
    let companion_installed = verified_in(models_dir, entry).is_some();
    let size = installed::expected(entry, &installed::record_path_for_dir(&dir))
        .map(|expected| expected.total_size())
        .or_else(|| sizes::download_size(entry));
    let running = downloads().get(&entry.id).map(|download| download.progress);
    let selected = selected_in(runtime_root, offered);
    // A version no companion needs is on disk only because this process
    // loaded it when a removal ran, and the next start removes it: it counts
    // as gone. A download of this companion keeps it, also before the
    // download has marked the companion's folder.
    let wanted = running.is_some() || npu_keeps || any_companion_in(models_dir, companions);
    let usable = selected.as_ref().ok().filter(|_| wanted);
    let removed_at_restart = selected.as_ref().ok().filter(|_| !wanted).map(|version| version.record.version.clone());
    let runtime = offered.map(|offered| {
        let installed = usable.map(|version| version.record.version.clone());
        let after_restart = usable
            .filter(|version| loaded.is_some_and(|loaded| loaded != version.dir.as_path()))
            .map(|version| version.record.version.clone());
        RuntimeStatus {
            name: offered.name.clone(),
            version: offered.version.clone(),
            license: offered.license.clone(),
            source: host(&offered.archive.url),
            download_size: offered.archive.size,
            installed_size: offered.installed_size(),
            installed,
            after_restart,
            removed_at_restart: removed_at_restart.clone(),
        }
    });
    // A download reuses the catalog's version wherever it is on disk, also
    // one awaiting its removal (`install_both` keeps it then).
    let runtime_current = matches!((&selected, offered), (Ok(version), Some(offered)) if version.record.version == offered.version)
        || (offered.is_none() && selected.is_ok());
    let runtime_fetch = if runtime_current { Some(0) } else { offered.map(|offered| offered.archive.size) };
    let companion_fetch = if companion_installed { Some(0) } else { size };
    // Without an entry this build can install, only an installed version can
    // run; a download is not offered.
    let refused = (offered.is_none() && usable.is_none()).then(refusal);
    CompanionStatus {
        id: entry.id.clone(),
        name: entry.name.clone(),
        description: entry.description.clone(),
        repo: entry.repo.clone(),
        companion_of: entry.companion_of.clone(),
        size,
        companion_installed,
        runtime,
        installed: companion_installed && usable.is_some(),
        download_size: runtime_fetch.zip(companion_fetch).map(|(runtime, model)| runtime + model),
        refused,
        downloading: running.map(Progress::percent),
        progress: running,
        stopped: None,
        removes_runtime: usable.is_some() && !npu_keeps && !others_keep_runtime(models_dir, entry, companions),
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(CHANGED_EVENT, ());
}

/// Work that must not lose its engine to an unload: anything but a model
/// download or onboarding (as `service::engines_busy`).
fn engines_busy() -> bool {
    busy::current()
        .into_iter()
        .any(|reason| !matches!(reason, BusyReason::ModelDownload | BusyReason::Onboarding))
}

/// Unloads the speech engines when nothing uses them, so the next load sees
/// a companion that was just installed or deleted. While something runs,
/// the idle unloader (`audio::common`) does it later.
async fn unload_engines_if_idle() {
    if engines_busy() {
        return;
    }
    let _guard = crate::audio::common::acquire_engine_lifecycle_lock().await;
    if !engines_busy() {
        crate::audio::common::unload_both_stt_engines().await;
    }
}

/// The companion of the Whisper model `whisper_model`, its runtime and their
/// state; `None` when the model has none. An unknown size is read from
/// Hugging Face in the background, and [`CHANGED_EVENT`] follows.
#[tauri::command]
pub async fn openvino_status<R: Runtime>(app: AppHandle<R>, whisper_model: String) -> Result<Option<CompanionStatus>, String> {
    let Some(entry) = companion_for(&whisper_model) else { return Ok(None) };
    let loaded = crate::whisper_engine::openvino::loaded_runtime_dir();
    let models = crate::paths::models_dir();
    let npu_keeps = crate::parakeet_engine::npu::state::keeps_runtime();
    let mut status =
        status_in(&models, &runtime_root(), &entry, runtime_entry().as_ref(), loaded.as_deref(), &super::companions(), npu_keeps);
    status.stopped = crate::whisper_engine::openvino::stopped();
    if status.size.is_none() {
        tauri::async_runtime::spawn(async move {
            if sizes::fill(&huggingface::client(), huggingface::HUB, &[entry]).await {
                emit(&app);
            }
        });
    }
    Ok(Some(status))
}

/// Installs what the companion `id` still lacks: the catalog's runtime
/// version, then the companion. Resolves when both are installed, one fails
/// or the download is cancelled; progress follows as [`CHANGED_EVENT`]. Also
/// installs a newer runtime the catalog pins (an update). Holds the busy
/// registry for its lifetime, like every model download. With `choose`
/// (#88) a download that ends installed also makes the companion the
/// after-meeting model (`crate::speech_choice::chosen`).
#[tauri::command]
pub async fn openvino_download<R: Runtime>(app: AppHandle<R>, id: String, choose: Option<bool>) -> Result<(), String> {
    let entry = companion(&id).ok_or_else(|| format!("{id} is not in the model list"))?;
    // With `choose` (#88) the work ends when the choice is saved, after the
    // install's own hold: an update must not restart the app in between.
    let _choosing = choose.unwrap_or(false).then(|| busy::hold(BusyReason::ModelDownload));
    let cancel = CancellationToken::new();
    {
        let mut downloads = downloads();
        if downloads.contains_key(&id) {
            return Err(format!("{} is already downloading", entry.name));
        }
        downloads.insert(id.clone(), Running { cancel: cancel.clone(), progress: Progress::default() });
    }
    emit(&app);
    let mut last = Instant::now() - PROGRESS_INTERVAL;
    let place = Place {
        models: crate::paths::models_dir(),
        runtime_root: runtime_root(),
        hub: huggingface::HUB.to_string(),
        fetch: runtimes::Fetch::Vendor,
    };
    let offered = runtime_entry().ok_or_else(refusal);
    let operations = OPERATIONS.lock().await;
    let result = install_both(&place, offered.as_ref().map_err(|reason| reason.clone()), &entry, &cancel, |done, total| {
        if last.elapsed() < PROGRESS_INTERVAL {
            return;
        }
        last = Instant::now();
        report(&id, Progress { done, total });
        emit(&app);
    })
    .await;
    if result.is_ok() {
        prune_runtimes(&runtime_root(), true, runtime_entry().as_ref());
    }
    drop(operations);
    downloads().remove(&id);
    match &result {
        Ok(()) => {
            log::info!("[openvino] {} and its runtime are installed", entry.id);
            unload_engines_if_idle().await;
            crate::parakeet_engine::npu::state::changed();
        }
        Err(error) if error.to_string() == CANCELLED => log::info!("[openvino] the download of {} was cancelled", entry.id),
        Err(error) => log::error!("[openvino] the download of {} failed: {error:#}", entry.id),
    }
    emit(&app);
    result.map_err(|error| error.to_string())?;
    if choose.unwrap_or(false) {
        crate::speech_choice::chosen(&app, &entry).await?;
    }
    Ok(())
}

/// The progress of [`openvino_runtime_download`], payload [`Progress`] (the
/// archive's bytes), at most every [`PROGRESS_INTERVAL`]. [`CHANGED_EVENT`]
/// follows too, as for a companion's download.
pub const RUNTIME_PROGRESS_EVENT: &str = "openvino-runtime-progress";

/// Installs the catalog's runtime alone, for Parakeet on the Intel NPU on a
/// PC that does not take the Intel GPU version of Whisper (#66), or adds to
/// an installed version the files the catalog pins since (the NPU plugin and
/// the ONNX frontend; `runtime::complete_into`). Resolves when it is
/// installed and fails with the reason, or [`CANCELLED`] after
/// `openvino_cancel` with the runtime's id (`openvino-genai`). Holds the busy
/// registry for its lifetime.
#[tauri::command]
pub async fn openvino_runtime_download<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let cancel = CancellationToken::new();
    {
        let mut downloads = downloads();
        if downloads.contains_key(OPENVINO_GENAI) {
            return Err("Intel's libraries are already downloading".to_string());
        }
        downloads.insert(OPENVINO_GENAI.to_string(), Running { cancel: cancel.clone(), progress: Progress::default() });
    }
    emit(&app);
    let mut last = Instant::now() - PROGRESS_INTERVAL;
    let offered = runtime_entry().ok_or_else(refusal);
    let operations = OPERATIONS.lock().await;
    let result = match &offered {
        Ok(offered) => {
            install_or_complete_runtime(&runtimes::Fetch::Vendor, &runtime_root(), offered, &cancel, |done, total| {
                if last.elapsed() < PROGRESS_INTERVAL {
                    return;
                }
                last = Instant::now();
                let progress = Progress { done, total };
                report(OPENVINO_GENAI, progress);
                let _ = app.emit(RUNTIME_PROGRESS_EVENT, progress);
                emit(&app);
            })
            .await
        }
        Err(reason) => Err(anyhow!("{reason}")),
    };
    if result.is_ok() {
        prune_runtimes(&runtime_root(), true, runtime_entry().as_ref());
    }
    drop(operations);
    downloads().remove(OPENVINO_GENAI);
    match &result {
        Ok(()) => {
            log::info!("[openvino] the runtime is installed");
            crate::parakeet_engine::npu::state::changed();
        }
        Err(error) if error.to_string() == CANCELLED => log::info!("[openvino] the download of the runtime was cancelled"),
        Err(error) => log::error!("[openvino] the download of the runtime failed: {error:#}"),
    }
    emit(&app);
    result.map_err(|error| error.to_string())
}

/// Installs `offered`, or completes the installed version of it, under
/// `root`. Callers hold [`OPERATIONS`].
async fn install_or_complete_runtime(
    fetch: &runtimes::Fetch,
    root: &Path,
    offered: &RuntimeEntry,
    cancel: &CancellationToken,
    progress: impl FnMut(u64, u64),
) -> Result<()> {
    let _busy = busy::hold(BusyReason::ModelDownload);
    match runtimes::missing_files(&root.join(&offered.version), offered) {
        Some(missing) if missing.is_empty() => Ok(()),
        Some(missing) => {
            let added: u64 = missing.iter().map(|file| file.size).sum();
            ensure_room(root, offered.archive.size + added, &offered.name).await?;
            log::info!("[openvino] adding {} files to {} {} from {}", missing.len(), offered.name, offered.version, host(&offered.archive.url));
            runtimes::complete_into(fetch, root, offered, cancel, progress).await.map(drop)
        }
        None => {
            ensure_room(root, offered.archive.size + offered.installed_size(), &offered.name).await?;
            log::info!("[openvino] installing {} {} from {}", offered.name, offered.version, host(&offered.archive.url));
            runtimes::install_into(fetch, root, offered, cancel, progress).await.map(drop)
        }
    }
}

/// Where an install puts things: the app's folders, or a test's.
struct Place {
    models: PathBuf,
    runtime_root: PathBuf,
    /// Hugging Face, for the companion.
    hub: String,
    /// Where the runtime comes from: its vendor, or a test's server.
    fetch: runtimes::Fetch,
}

/// The runtime `offered` and then the companion, each only when it is not
/// installed, holding the busy registry throughout; `progress` gets the
/// bytes done and the total of both. Callers hold [`OPERATIONS`].
async fn install_both(
    place: &Place,
    offered: std::result::Result<&RuntimeEntry, String>,
    entry: &Entry,
    cancel: &CancellationToken,
    mut progress: impl FnMut(u64, u64),
) -> Result<()> {
    let _busy = busy::hold(BusyReason::ModelDownload);
    let offered = offered.map_err(|reason| anyhow!(reason))?;
    let runtime_needed = !runtimes::installed_in(&place.runtime_root)
        .iter()
        .any(|version| version.record.version == offered.version && version.record.api == API_LEVEL);
    let companion_needed = verified_in(&place.models, entry).is_none();
    let runtime_total = if runtime_needed { offered.archive.size } else { 0 };
    let companion_estimate = if companion_needed { sizes::download_size(entry).unwrap_or(0) } else { 0 };
    if runtime_needed {
        ensure_room(&place.runtime_root, offered.archive.size + offered.installed_size(), &offered.name).await?;
        log::info!("[openvino] installing {} {} from {}", offered.name, offered.version, host(&offered.archive.url));
        runtimes::install_into(&place.fetch, &place.runtime_root, offered, cancel, |done, _| {
            progress(done, runtime_total + companion_estimate)
        })
        .await?;
    }
    if companion_needed {
        let dir = dir_in(&place.models, entry);
        let requested = dir.join(REQUESTED);
        if runtime_needed {
            if let Err(error) = std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&requested, b"")) {
                log::warn!("[openvino] cannot mark {} as requested: {error}", entry.id);
            }
        }
        let files = huggingface::builder().connect_timeout(STALL).build().unwrap_or_default();
        download_into(&huggingface::client(), &files, &place.hub, &place.models, entry, cancel, |done, total| {
            progress(runtime_total + done, runtime_total + total)
        })
        .await?;
        // Its record keeps the runtime from now on.
        let _ = std::fs::remove_file(&requested);
    }
    Ok(())
}

/// Refuses an install that would not fit on the volume of `dir`.
async fn ensure_room(dir: &Path, needed: u64, name: &str) -> Result<()> {
    let probe = dir.ancestors().find(|ancestor| ancestor.exists()).unwrap_or(dir).to_path_buf();
    let free = tokio::task::spawn_blocking(move || crate::updater::engine::free_space(&probe)).await.ok().flatten();
    match free {
        Some(free) if free < needed => bail!(
            "Not enough free space for {name}: it needs {} MB, {} MB are free",
            needed.div_ceil(1 << 20),
            free / (1 << 20)
        ),
        _ => Ok(()),
    }
}

/// Turns OpenVINO on again after the app closed unexpectedly inside it: the
/// next model load tries it (and if it crashes again, the next start stops
/// it again).
#[tauri::command]
pub async fn openvino_retry<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::whisper_engine::openvino::retry();
    log::info!("[openvino] retrying OpenVINO after a crash stopped it");
    unload_engines_if_idle().await;
    emit(&app);
    Ok(())
}

#[tauri::command]
pub async fn openvino_cancel(id: String) -> Result<(), String> {
    match downloads().get(&id) {
        Some(download) => {
            download.cancel.cancel();
            Ok(())
        }
        None => Err(format!("{id} is not downloading")),
    }
}

/// Removes the companion `id`, and the runtime and the model cache when no
/// other companion needs them. Refused during a download of it and while the
/// speech engines are at work: the loaded pipeline maps these files, so they
/// are unloaded first, under the engine lifecycle lock. A runtime version
/// this process loaded stays until the next start.
#[tauri::command]
pub async fn openvino_remove<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let entry = companion(&id).ok_or_else(|| format!("{id} is not in the model list"))?;
    let downloading = || downloads().contains_key(&id).then(|| format!("Cancel the download of {} first", entry.name));
    if let Some(refused) = downloading() {
        return Err(refused);
    }
    let busy_message = || "Protocol is transcribing right now. Remove it when it is done.".to_string();
    if engines_busy() {
        return Err(busy_message());
    }
    {
        // A download registers before it waits for this lock: one that
        // started meanwhile is seen here, and one that starts later runs
        // after the removal.
        let _operations = OPERATIONS.lock().await;
        if let Some(refused) = downloading() {
            return Err(refused);
        }
        let _guard = crate::audio::common::acquire_engine_lifecycle_lock().await;
        if engines_busy() {
            return Err(busy_message());
        }
        crate::audio::common::unload_both_stt_engines().await;
        let models = crate::paths::models_dir();
        remove_in(&models, &entry).map_err(|error| error.to_string())?;
        // The last companion takes Whisper's cache; the runtime goes too
        // unless Parakeet on the NPU keeps it (#66).
        if !any_companion_in(&models, &super::companions()) {
            crate::whisper_engine::openvino::remove_cache();
            if !crate::parakeet_engine::npu::state::keeps_runtime() {
                prune_runtimes(&runtime_root(), false, None);
                crate::parakeet_engine::npu::state::runtime_removed();
            }
        }
    }
    log::info!("[openvino] {} removed", entry.id);
    emit(&app);
    Ok(())
}

/// Removes the record first: a deletion stopped halfway then leaves files
/// nothing trusts, never a record that vouches for missing ones.
fn remove_in(models_dir: &Path, entry: &Entry) -> Result<()> {
    let dir = dir_in(models_dir, entry);
    installed::remove_record(&installed::record_path_for_dir(&dir));
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow!("Could not delete {}: {error}", dir.display())),
    }
}

/// Downloads `entry` into its folder under `models_dir` and returns the
/// folder. `api` reads the repository listing, `files` fetches the files;
/// `progress` gets the bytes done and the total.
async fn download_into(
    api: &reqwest::Client,
    files: &reqwest::Client,
    hub: &str,
    models_dir: &Path,
    entry: &Entry,
    cancel: &CancellationToken,
    mut progress: impl FnMut(u64, u64),
) -> Result<PathBuf> {
    let dir = dir_in(models_dir, entry);
    let record_path = installed::record_path_for_dir(&dir);
    let plan = tokio::select! {
        _ = cancel.cancelled() => bail!(CANCELLED),
        plan = installed::plan_download(api, hub, entry, &record_path) => plan?,
    };
    tokio::fs::create_dir_all(&dir).await?;
    if !plan.keep_partial {
        // Partial files of another commit would only fail their final hash.
        for file in &plan.resolved.files {
            let path = dir.join(&file.name);
            if tokio::fs::metadata(&path).await.is_ok_and(|metadata| metadata.len() < file.pinned.size) {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
    }
    installed::write_record(&record_path, &InstallRecord::from_resolved(&entry.id, &plan.resolved, false))
        .map_err(|error| anyhow!("Could not write the install record of {}: {error}", entry.name))?;

    let total = plan.resolved.total_size();
    let mut done = 0u64;
    for file in &plan.resolved.files {
        let pinned = file.pinned;
        let path = dir.join(&file.name);
        let on_disk = tokio::fs::metadata(&path).await.map(|metadata| metadata.len()).unwrap_or(0);
        if on_disk == pinned.size {
            // Left by an interrupted download or a marker lost since: hashed
            // once rather than trusted for its size; a mismatch is deleted.
            let token = cancel.clone();
            match model_integrity::ensure_verified_cancellable(pinned, &path, move || token.is_cancelled()).await {
                Ok(()) => {
                    done += pinned.size;
                    progress(done, total);
                    continue;
                }
                Err(_) if cancel.is_cancelled() => bail!(CANCELLED),
                Err(error) => log::warn!("[openvino] {error}; downloading it again"),
            }
        } else if on_disk > pinned.size {
            tokio::fs::remove_file(&path).await?;
        }
        let resume = tokio::fs::metadata(&path).await.map(|metadata| metadata.len()).unwrap_or(0);
        let before = done;
        fetch(files, &file.url, &path, pinned, resume, cancel, |file_done| progress(before + file_done, total)).await?;
        done += pinned.size;
        progress(done, total);
    }
    if cancel.is_cancelled() {
        bail!(CANCELLED);
    }
    installed::write_record(&record_path, &InstallRecord::from_resolved(&entry.id, &plan.resolved, true))
        .map_err(|error| anyhow!("Could not write the install record of {}: {error}", entry.name))?;
    Ok(dir)
}

/// Fetches one file to `path`, resuming after its first `resume` bytes when
/// the server answers the range, and checks it against `pinned` as it
/// streams in. A file that does not match is deleted (`Check::finish`).
async fn fetch(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    pinned: &'static Pinned,
    resume: u64,
    cancel: &CancellationToken,
    mut progress: impl FnMut(u64),
) -> Result<()> {
    let mut request = client.get(url);
    if resume > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={resume}-"));
    }
    let response = tokio::select! {
        _ = cancel.cancelled() => bail!(CANCELLED),
        result = tokio::time::timeout(STALL, request.send()) => result
            .map_err(|_| anyhow!("Could not download {}: no answer for 30 seconds", pinned.file))??,
    };
    let status = response.status();
    // A 206 must start where the kept bytes end; anything else starts over.
    let resuming = resume > 0
        && status == reqwest::StatusCode::PARTIAL_CONTENT
        && response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|range| range.starts_with(&format!("bytes {resume}-")));
    if !(status == reqwest::StatusCode::OK || resuming) {
        bail!("Could not download {}: the server answered {status}", pinned.file);
    }
    let mut check = if resuming {
        let token = cancel.clone();
        match model_integrity::Check::resume(pinned, path, move || token.is_cancelled()).await {
            Ok(check) => check,
            Err(_) if cancel.is_cancelled() => bail!(CANCELLED),
            Err(error) => return Err(error),
        }
    } else {
        model_integrity::Check::new(pinned)
    };
    let file = if resuming {
        tokio::fs::OpenOptions::new().append(true).open(path).await?
    } else {
        tokio::fs::File::create(path).await?
    };
    let mut writer = tokio::io::BufWriter::with_capacity(8 << 20, file);
    let mut written = if resuming { resume } else { 0 };
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // The bytes so far stay for the next attempt to resume.
                writer.flush().await?;
                bail!(CANCELLED);
            }
            next = tokio::time::timeout(STALL, stream.next()) => next,
        };
        let chunk = match next {
            Err(_) => bail!("Could not download {}: no data for 30 seconds", pinned.file),
            Ok(None) => break,
            Ok(Some(chunk)) => chunk.map_err(|error| anyhow!("Could not download {}: {error}", pinned.file))?,
        };
        check.update(&chunk)?;
        writer.write_all(&chunk).await?;
        written += chunk.len() as u64;
        progress(written);
    }
    writer.flush().await?;
    // Closed before its marker records the modification time.
    drop(writer);
    if written != pinned.size {
        bail!("Could not download {}: stopped at {written} of {} bytes", pinned.file, pinned.size);
    }
    check.finish(path)?;
    model_integrity::mark_verified(pinned, path);
    Ok(())
}

#[cfg(test)]
#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_catalog::schema::{CatalogFile, Engine, OPENVINO_IR, OPENVINO_WHISPER_FILES};
    use crate::model_catalog::testing::{entry_for, Hub};

    const COMMIT: &str = "b568445dd5dc8c695bde596f8acbb4694fd6ba64";

    fn companion_entry() -> Entry {
        let mut entry = entry_for(Engine::Whisper, "turbo-ov", "owner/turbo-ov");
        entry.format = OPENVINO_IR.to_string();
        entry.files = OPENVINO_WHISPER_FILES
            .iter()
            .map(|name| CatalogFile { name: name.to_string(), path: name.to_string() })
            .collect();
        entry.companion_of = vec!["large-v3-turbo".to_string()];
        entry.runtime = Some(OPENVINO_GENAI.to_string());
        entry.revision = Some(COMMIT.to_string());
        assert!(entry.problems().is_empty(), "{:?}", entry.problems());
        entry
    }

    /// The repository with a distinct small content per file: weights in LFS,
    /// the XML and JSON files in Git, as on Hugging Face.
    fn hub_with_model() -> (Hub, Vec<Vec<u8>>) {
        hub_with_model_in("owner/turbo-ov")
    }

    /// [`hub_with_model`] under another repository name, whose sizes no
    /// other test lists.
    fn hub_with_model_in(name: &str) -> (Hub, Vec<Vec<u8>>) {
        let mut hub = Hub::new();
        let contents: Vec<Vec<u8>> =
            (0..OPENVINO_WHISPER_FILES.len()).map(|index| vec![index as u8 + 1; 40 + index * 3]).collect();
        let mut repo = hub.repo(name, COMMIT);
        for (name, content) in OPENVINO_WHISPER_FILES.iter().zip(&contents) {
            if name.ends_with(".bin") {
                repo.lfs_file(name, content);
            } else {
                repo.git_file(name, content);
            }
        }
        (hub, contents)
    }

    #[tokio::test]
    async fn a_download_installs_every_file_verified_and_the_companion_counts_as_installed() {
        let (hub, contents) = hub_with_model();
        let hub = hub.serve().await;
        let models = tempfile::tempdir().unwrap();
        let entry = companion_entry();
        assert_eq!(verified_in(models.path(), &entry), None);

        let mut reported = Vec::new();
        let client = huggingface::client();
        let dir = download_into(&client, &client, &hub.url, models.path(), &entry, &CancellationToken::new(), |done, total| {
            reported.push((done, total))
        })
        .await
        .unwrap();

        assert_eq!(dir, models.path().join("openvino").join("turbo-ov"));
        for (name, content) in OPENVINO_WHISPER_FILES.iter().zip(&contents) {
            assert_eq!(&std::fs::read(dir.join(name)).unwrap(), content);
        }
        let total: u64 = contents.iter().map(|content| content.len() as u64).sum();
        assert_eq!(reported.last(), Some(&(total, total)));
        let record = installed::read_record(&installed::record_path_for_dir(&dir)).unwrap();
        assert!(record.complete);
        assert_eq!(record.commit, COMMIT);
        assert_eq!(verified_in(models.path(), &entry), Some(dir.clone()));

        // A file changed since its check loses its marker: not installed
        // until a download checks the folder again, which fetches only it.
        std::fs::write(dir.join("config.json"), b"changed").unwrap();
        assert_eq!(verified_in(models.path(), &entry), None);
        let before = hub.requests(&format!("/owner/turbo-ov/resolve/{COMMIT}/openvino_encoder_model.bin"));
        download_into(&client, &client, &hub.url, models.path(), &entry, &CancellationToken::new(), |_, _| {})
            .await
            .unwrap();
        assert_eq!(hub.requests(&format!("/owner/turbo-ov/resolve/{COMMIT}/openvino_encoder_model.bin")), before);
        assert_eq!(std::fs::read(dir.join("config.json")).unwrap(), contents[8]);
        assert_eq!(verified_in(models.path(), &entry), Some(dir.clone()));

        remove_in(models.path(), &entry).unwrap();
        assert!(!dir.exists());
        assert_eq!(verified_in(models.path(), &entry), None);
    }

    #[tokio::test]
    async fn bytes_that_do_not_match_their_pin_are_deleted_and_the_record_stays_incomplete() {
        let mut hub = Hub::new();
        let mut repo = hub.repo("owner/turbo-ov", COMMIT);
        for (index, name) in OPENVINO_WHISPER_FILES.iter().enumerate() {
            let content = vec![index as u8 + 1; 50];
            if *name == "openvino_decoder_model.bin" {
                // Listed with one content, served with another.
                repo.lfs_file_serving(name, &content, &[0u8; 50]);
            } else if name.ends_with(".bin") {
                repo.lfs_file(name, &content);
            } else {
                repo.git_file(name, &content);
            }
        }
        let hub = hub.serve().await;
        let models = tempfile::tempdir().unwrap();
        let entry = companion_entry();
        let client = huggingface::client();

        let error = download_into(&client, &client, &hub.url, models.path(), &entry, &CancellationToken::new(), |_, _| {})
            .await
            .unwrap_err();
        assert!(error.to_string().contains("openvino_decoder_model.bin"), "{error}");
        let dir = dir_in(models.path(), &entry);
        assert!(!dir.join("openvino_decoder_model.bin").exists());
        assert!(!installed::read_record(&installed::record_path_for_dir(&dir)).unwrap().complete);
        assert_eq!(verified_in(models.path(), &entry), None);
    }

    #[tokio::test]
    async fn a_cancelled_download_installs_nothing() {
        let (hub, _) = hub_with_model();
        let hub = hub.serve().await;
        let models = tempfile::tempdir().unwrap();
        let entry = companion_entry();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let client = huggingface::client();
        let error = download_into(&client, &client, &hub.url, models.path(), &entry, &cancel, |_, _| {}).await.unwrap_err();
        assert_eq!(error.to_string(), CANCELLED);
        assert_eq!(verified_in(models.path(), &entry), None);
    }

    #[test]
    fn the_built_in_companion_serves_large_v3_turbo_and_is_found_by_its_models() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        for id in ["large-v3-turbo", "large-v3-turbo-q5_0"] {
            let entry = companion_for(id).unwrap_or_else(|| panic!("{id} has no companion"));
            assert_eq!(entry.repo, "OpenVINO/whisper-large-v3-turbo-int8-ov");
        }
        assert!(companion_for("small").is_none());
    }

    #[test]
    fn the_engine_and_the_catalog_expect_the_same_files() {
        let mut engine: Vec<&str> = crate::whisper_engine::openvino::MODEL_FILES.to_vec();
        let mut catalog: Vec<&str> = OPENVINO_WHISPER_FILES.to_vec();
        engine.sort_unstable();
        catalog.sort_unstable();
        assert_eq!(engine, catalog);
    }

    #[test]
    fn the_built_in_companion_names_the_built_in_runtime_this_build_runs() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let companion = companion_for("large-v3-turbo").unwrap();
        assert_eq!(companion.runtime.as_deref(), Some(OPENVINO_GENAI));
        let runtime = runtime_entry().expect("the built-in catalog pins a runtime this build runs");
        assert_eq!(runtime.api, API_LEVEL);
        assert!(runtime.archive.url.starts_with("https://storage.openvinotoolkit.org/"));
        // The libraries the binding opens are among the pinned files.
        for library in [crate::whisper_engine::openvino::genai::GENAI_C_LIBRARY, "openvino_c.dll"] {
            assert!(runtime.files.iter().any(|file| file.name == library), "{library}");
        }
    }

    /// An archive with the two libraries the binding opens, as an entry of
    /// `version` at API level `api`, its archive served locally.
    async fn runtime_entry_served(version: &str, salt: u8, api: u32) -> RuntimeEntry {
        let files = runtimes::testing::openvino_files(salt);
        let borrowed: Vec<(&str, &str, &[u8])> = files.iter().map(|(path, name, content)| (*path, *name, content.as_slice())).collect();
        let (bytes, mut entry) = runtimes::testing::archive_and_entry(version, &borrowed, "https://example.com/runtime.zip");
        entry.api = api;
        entry.archive.url = runtimes::testing::serve(bytes).await;
        entry
    }

    fn test_place(data: &Path, hub: &str) -> Place {
        Place {
            models: data.join("models"),
            runtime_root: data.join("runtimes"),
            hub: hub.to_string(),
            fetch: runtimes::Fetch::Local(reqwest::Client::new()),
        }
    }

    async fn install_runtime(root: &Path, version: &str, salt: u8, api: u32) -> PathBuf {
        let entry = runtime_entry_served(version, salt, api).await;
        runtimes::install_into(&runtimes::Fetch::Local(reqwest::Client::new()), root, &entry, &CancellationToken::new(), |_, _| {}).await.unwrap()
    }

    /// The runtime alone (#66): installed when missing, completed when the
    /// catalog pins more files of the installed version, else left alone.
    #[tokio::test]
    async fn the_runtime_alone_is_installed_or_completed_and_holds_the_busy_registry() {
        let data = tempfile::tempdir().unwrap();
        let root = data.path().join("runtimes");
        let fetch = runtimes::Fetch::Local(reqwest::Client::new());
        let old = runtime_entry_served("2026.4.1.0", 8, API_LEVEL).await;
        let mut held = false;
        install_or_complete_runtime(&fetch, &root, &old, &CancellationToken::new(), |_, _| {
            held |= busy::current().contains(&BusyReason::ModelDownload);
        })
        .await
        .unwrap();
        assert!(held, "the download did not hold the busy registry");
        assert_eq!(runtimes::installed_in(&root)[0].record.files.len(), 3);

        let mut files = runtimes::testing::openvino_files(8);
        files.push(("root/runtime/bin/openvino_intel_npu_plugin.dll", "openvino_intel_npu_plugin.dll", vec![8; 40]));
        let borrowed: Vec<(&str, &str, &[u8])> = files.iter().map(|(path, name, content)| (*path, *name, content.as_slice())).collect();
        let (bytes, mut more) = runtimes::testing::archive_and_entry("2026.4.1.0", &borrowed, "https://example.com/runtime.zip");
        more.archive.url = runtimes::testing::serve(bytes).await;
        install_or_complete_runtime(&fetch, &root, &more, &CancellationToken::new(), |_, _| {}).await.unwrap();
        let installed = runtimes::installed_in(&root);
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].record.files.len(), 4);
        install_or_complete_runtime(&fetch, &root, &more, &CancellationToken::new(), |_, _| panic!("downloaded again")).await.unwrap();
    }

    #[tokio::test]
    async fn the_runtime_that_loads_is_the_catalogs_version_else_the_newest_of_this_api_level() {
        let data = tempfile::tempdir().unwrap();
        let root = runtimes::root_in(data.path(), OPENVINO_GENAI);
        assert_eq!(selected_in(&root, None).unwrap_err(), "the OpenVINO runtime is not installed");

        // A version of another API level is never loaded, and says why.
        install_runtime(&root, "2027.0.0.0", 9, API_LEVEL + 1).await;
        let refused = selected_in(&root, None).unwrap_err();
        assert!(refused.contains("2027.0.0.0") && refused.contains("cannot run"), "{refused}");

        let old = install_runtime(&root, "2026.4.1.0", 1, API_LEVEL).await;
        // An update the catalog pins but that is not downloaded yet: the
        // older version keeps running meanwhile.
        let pinned_new = runtime_entry_served("2026.5.0.0", 2, API_LEVEL).await;
        assert_eq!(selected_in(&root, Some(&pinned_new)).unwrap().dir, old);
        let new = install_runtime(&root, "2026.5.0.0", 2, API_LEVEL).await;
        assert_eq!(selected_in(&root, None).unwrap().dir, new);
        assert_eq!(selected_in(&root, Some(&pinned_new)).unwrap().dir, new);
        // The catalog steps back (a rollback): the older one loads.
        let pinned_old = runtime_entry_served("2026.4.1.0", 1, API_LEVEL).await;
        assert_eq!(selected_in(&root, Some(&pinned_old)).unwrap().dir, old);

        // Pruning keeps what loads; without a companion nothing stays.
        prune_runtimes(&root, true, Some(&pinned_old));
        assert_eq!(runtimes::installed_in(&root).into_iter().map(|version| version.dir).collect::<Vec<_>>(), [old]);
        prune_runtimes(&root, false, None);
        assert!(!root.exists());
    }

    #[tokio::test]
    async fn a_version_the_catalog_withdrew_never_loads_even_when_it_is_the_only_one() {
        let data = tempfile::tempdir().unwrap();
        let root = runtimes::root_in(data.path(), OPENVINO_GENAI);
        install_runtime(&root, "2026.5.0.0", 2, API_LEVEL).await;
        let pinned_old = runtime_entry_served("2026.4.1.0", 1, API_LEVEL).await;
        let refused = selected_in(&root, Some(&pinned_old)).unwrap_err();
        assert!(refused.contains("no longer offers OpenVINO GenAI 2026.5.0.0") && refused.contains("download 2026.4.1.0"), "{refused}");

        // Settings offers the catalog's version for download, and the next
        // prune removes the withdrawn one.
        let entry = companion_entry();
        let status = status_in(&data.path().join("models"), &root, &entry, Some(&pinned_old), None, std::slice::from_ref(&entry), false);
        assert!(!status.installed);
        assert_eq!(status.runtime.unwrap().installed, None);
        prune_runtimes(&root, true, Some(&pinned_old));
        assert!(runtimes::installed_in(&root).is_empty());
    }

    #[tokio::test]
    async fn a_runtime_installed_for_a_companion_stays_until_the_companion_is_installed_or_removed() {
        let data = tempfile::tempdir().unwrap();
        // Hugging Face cannot be reached: the companion's part fails before
        // it has a record.
        let place = test_place(data.path(), "http://127.0.0.1:9");
        let entry = companion_entry();
        let offered = runtime_entry_served("2026.4.1.0", 3, API_LEVEL).await;
        install_both(&place, Ok(&offered), &entry, &CancellationToken::new(), |_, _| {}).await.unwrap_err();
        assert_eq!(runtimes::installed_in(&place.runtime_root).len(), 1);
        assert!(installed::read_record(&installed::record_path_for_dir(&dir_in(&place.models, &entry))).is_none());

        // The next start keeps it, and the next click fetches only the companion.
        assert!(any_companion_in(&place.models, std::slice::from_ref(&entry)));
        prune_runtimes(&place.runtime_root, true, Some(&offered));
        assert_eq!(runtimes::installed_in(&place.runtime_root).len(), 1);
        let status = status_in(&place.models, &place.runtime_root, &entry, Some(&offered), None, std::slice::from_ref(&entry), false);
        assert_eq!(status.runtime.unwrap().installed.as_deref(), Some("2026.4.1.0"));

        // Removing the companion lets the runtime go.
        remove_in(&place.models, &entry).unwrap();
        assert!(!any_companion_in(&place.models, std::slice::from_ref(&entry)));
    }

    /// A removal keeps a runtime this process loaded until the next start
    /// (`prune_runtimes`). Meanwhile Settings counts it as gone: a note that
    /// the next start removes it, no offer to remove libraries that a click
    /// cannot delete (QA B2), and the size a download then fetches, which
    /// reuses those libraries (QA N1).
    #[tokio::test]
    async fn a_runtime_awaiting_its_removal_at_the_next_start_counts_as_gone() {
        let data = tempfile::tempdir().unwrap();
        let place = test_place(data.path(), "http://127.0.0.1:9");
        let mut entry = companion_entry();
        // Its own id and repository: the running downloads and the listed
        // sizes are shared by the tests.
        entry.id = "removal-openvino-int8".to_string();
        entry.repo = "owner/removal-ov".to_string();
        let (hub, contents) = hub_with_model_in(&entry.repo);
        let hub = hub.serve().await;
        assert!(sizes::fill(&huggingface::client(), &hub.url, std::slice::from_ref(&entry)).await);
        let companion: u64 = contents.iter().map(|content| content.len() as u64).sum();
        let companions = [entry.clone()];
        let offered = runtime_entry_served("2026.4.1.0", 5, API_LEVEL).await;
        // The libraries without the model, as a failed or cancelled download leaves them.
        install_both(&place, Ok(&offered), &entry, &CancellationToken::new(), |_, _| {}).await.unwrap_err();
        let loaded = runtimes::installed_in(&place.runtime_root)[0].dir.clone();
        let status = || status_in(&place.models, &place.runtime_root, &entry, Some(&offered), Some(&loaded), &companions, false);
        let before = status();
        let runtime = before.runtime.unwrap();
        assert_eq!((runtime.installed.as_deref(), runtime.removed_at_restart), (Some("2026.4.1.0"), None));
        assert!(before.removes_runtime);

        // Removed while loaded: the prune would keep the loaded version
        // (the test process has none loaded, so it is not called).
        remove_in(&place.models, &entry).unwrap();
        let after = status();
        let runtime = after.runtime.clone().unwrap();
        assert_eq!(
            (runtime.installed, runtime.after_restart, runtime.removed_at_restart.as_deref()),
            (None, None, Some("2026.4.1.0"))
        );
        assert!(!after.installed && !after.removes_runtime);
        // A download now keeps the libraries and fetches the companion alone.
        assert_eq!((after.size, after.download_size), (Some(companion), Some(companion)));

        // A download of the companion keeps the runtime from its first moment.
        downloads().insert(entry.id.clone(), Running { cancel: CancellationToken::new(), progress: Progress::default() });
        let downloading = status().runtime.unwrap();
        downloads().remove(&entry.id);
        assert_eq!((downloading.installed.as_deref(), downloading.removed_at_restart), (Some("2026.4.1.0"), None));

        // Parakeet on the NPU keeps the runtime (#66): it stays installed in
        // the status, and removing a companion would not remove it.
        let kept = status_in(&place.models, &place.runtime_root, &entry, Some(&offered), Some(&loaded), &companions, true);
        let runtime = kept.runtime.clone().unwrap();
        assert_eq!((runtime.installed.as_deref(), runtime.removed_at_restart), (Some("2026.4.1.0"), None));
        assert!(!kept.installed && !kept.removes_runtime);
    }

    /// Settings offers to remove libraries left without their model only
    /// when that removal deletes them: not while another companion keeps them.
    #[test]
    fn removing_a_companion_frees_the_runtime_only_when_no_other_companion_keeps_it() {
        let data = tempfile::tempdir().unwrap();
        let models = data.path().join("models");
        let entry = companion_entry();
        let mut other = companion_entry();
        other.id = "other-openvino-int8".to_string();
        let companions = [entry.clone(), other.clone()];
        assert!(!others_keep_runtime(&models, &entry, &companions));

        // This companion's own marker does not count; the other one's does.
        for (dir, keeps) in [(dir_in(&models, &entry), false), (dir_in(&models, &other), true)] {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(REQUESTED), b"").unwrap();
            assert_eq!(others_keep_runtime(&models, &entry, &companions), keeps);
        }
        assert!(!others_keep_runtime(&models, &other, std::slice::from_ref(&other)));
    }

    #[tokio::test]
    async fn the_status_says_what_a_download_fetches_and_offers_a_new_runtime() {
        let (hub, contents) = hub_with_model();
        let hub = hub.serve().await;
        let data = tempfile::tempdir().unwrap();
        let models = data.path().join("models");
        let root = runtimes::root_in(data.path(), OPENVINO_GENAI);
        let entry = companion_entry();
        let current = runtime_entry_served("2026.4.1.0", 1, API_LEVEL).await;
        let companion_size: u64 = contents.iter().map(|content| content.len() as u64).sum();

        let client = huggingface::client();
        download_into(&client, &client, &hub.url, &models, &entry, &CancellationToken::new(), |_, _| {}).await.unwrap();
        let status = status_in(&models, &root, &entry, Some(&current), None, std::slice::from_ref(&entry), false);
        assert!(status.companion_installed && !status.installed);
        assert_eq!(status.size, Some(companion_size));
        // Only the runtime is missing: a download fetches its archive.
        assert_eq!(status.download_size, Some(current.archive.size));
        let runtime = status.runtime.unwrap();
        assert_eq!((runtime.installed, runtime.version.as_str()), (None, "2026.4.1.0"));
        assert_eq!(runtime.download_size, current.archive.size);
        assert_eq!(runtime.installed_size, current.installed_size());
        assert!(runtime.source.starts_with("127.0.0.1:"), "{}", runtime.source);
        assert_eq!(status.refused, None);

        let old = runtimes::install_into(&runtimes::Fetch::Local(reqwest::Client::new()), &root, &current, &CancellationToken::new(), |_, _| {}).await.unwrap();
        let status = status_in(&models, &root, &entry, Some(&current), None, std::slice::from_ref(&entry), false);
        assert!(status.installed);
        assert_eq!(status.download_size, Some(0));
        assert_eq!(status.runtime.unwrap().installed.as_deref(), Some("2026.4.1.0"));

        // The catalog pins a newer runtime: offered as an update, while the
        // installed one keeps running.
        let newer = runtime_entry_served("2026.5.0.0", 2, API_LEVEL).await;
        let status = status_in(&models, &root, &entry, Some(&newer), Some(&old), std::slice::from_ref(&entry), false);
        assert!(status.installed);
        assert_eq!(status.download_size, Some(newer.archive.size));
        let runtime = status.runtime.unwrap();
        assert_eq!((runtime.installed.as_deref(), runtime.version.as_str()), (Some("2026.4.1.0"), "2026.5.0.0"));
        assert_eq!(runtime.after_restart, None);

        // Installed while this process runs the old one: used after a restart.
        runtimes::install_into(&runtimes::Fetch::Local(reqwest::Client::new()), &root, &newer, &CancellationToken::new(), |_, _| {}).await.unwrap();
        let runtime = status_in(&models, &root, &entry, Some(&newer), Some(&old), std::slice::from_ref(&entry), false).runtime.unwrap();
        assert_eq!(runtime.installed.as_deref(), Some("2026.5.0.0"));
        assert_eq!(runtime.after_restart.as_deref(), Some("2026.5.0.0"));
    }

    #[test]
    fn without_a_runtime_this_build_can_install_the_download_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let entry = companion_entry();
        let root = runtimes::root_in(data.path(), OPENVINO_GENAI);
        let status = status_in(&data.path().join("models"), &root, &entry, None, None, std::slice::from_ref(&entry), false);
        assert!(status.refused.is_some());
        assert_eq!((status.runtime, status.download_size, status.installed), (None, None, false));
    }

    #[tokio::test]
    async fn one_download_installs_the_runtime_then_the_companion_and_holds_the_busy_registry() {
        let (hub, contents) = hub_with_model();
        let hub = hub.serve().await;
        let data = tempfile::tempdir().unwrap();
        let place = test_place(data.path(), &hub.url);
        let entry = companion_entry();
        let offered = runtime_entry_served("2026.4.1.0", 3, API_LEVEL).await;
        let mut reported = Vec::new();
        install_both(&place, Ok(&offered), &entry, &CancellationToken::new(), |done, total| {
            assert!(busy::current().contains(&BusyReason::ModelDownload));
            reported.push((done, total));
        })
        .await
        .unwrap();

        assert_eq!(selected_in(&place.runtime_root, Some(&offered)).unwrap().record.version, "2026.4.1.0");
        assert!(verified_in(&place.models, &entry).is_some());
        let total = offered.archive.size + contents.iter().map(|content| content.len() as u64).sum::<u64>();
        assert_eq!(reported.last(), Some(&(total, total)));
        assert!(reported.windows(2).all(|pair| pair[0].0 <= pair[1].0), "{reported:?}");

        // A second click finds both installed and fetches nothing.
        install_both(&place, Ok(&offered), &entry, &CancellationToken::new(), |_, _| panic!("downloaded again")).await.unwrap();

        // An update fetches the runtime's archive alone, and its progress
        // counts only that, not the companion it leaves in place.
        let newer = runtime_entry_served("2026.5.0.0", 4, API_LEVEL).await;
        let mut reported = Vec::new();
        install_both(&place, Ok(&newer), &entry, &CancellationToken::new(), |done, total| reported.push((done, total))).await.unwrap();
        assert!(reported.iter().all(|(_, total)| *total == newer.archive.size), "{reported:?}");
        assert_eq!(reported.last(), Some(&(newer.archive.size, newer.archive.size)));

        // The companion alone, after the runtime is in: its own bytes.
        remove_in(&place.models, &entry).unwrap();
        let mut reported = Vec::new();
        install_both(&place, Ok(&newer), &entry, &CancellationToken::new(), |done, total| reported.push((done, total))).await.unwrap();
        let companion: u64 = contents.iter().map(|content| content.len() as u64).sum();
        assert_eq!(reported.last(), Some(&(companion, companion)));
    }

    /// Settings shows a running download's own bytes, which the row's sizes
    /// stop matching once a part is installed during it.
    #[test]
    fn a_running_download_reports_its_bytes_and_never_100_before_the_end() {
        let data = tempfile::tempdir().unwrap();
        let root = runtimes::root_in(data.path(), OPENVINO_GENAI);
        let mut entry = companion_entry();
        // Its own id: the running downloads are shared by the tests.
        entry.id = "progress-openvino-int8".to_string();
        let status = || status_in(&data.path().join("models"), &root, &entry, None, None, std::slice::from_ref(&entry), false);
        assert_eq!((status().downloading, status().progress), (None, None));

        downloads().insert(entry.id.clone(), Running { cancel: CancellationToken::new(), progress: Progress::default() });
        assert_eq!((status().downloading, status().progress), (Some(0), Some(Progress::default())));
        let quarter = Progress { done: 50 << 20, total: 200 << 20 };
        report(&entry.id, quarter);
        assert_eq!((status().downloading, status().progress), (Some(25), Some(quarter)));
        report(&entry.id, Progress { done: 200 << 20, total: 200 << 20 });
        assert_eq!(status().downloading, Some(99));
        downloads().remove(&entry.id);
    }

    /// The real install from Intel's server (network): the built-in
    /// catalog's runtime into `OPENVINO_INSTALL_DATA`, a scratch data folder,
    /// whose `runtimes/openvino-genai/<version>` the kit's
    /// `MEASURE_OPENVINO_RUNTIME` can then name. As the app does: the pinned
    /// host and Intel's signature on every library. It loads the libraries,
    /// but creates no OpenVINO core, so no device is touched.
    #[tokio::test]
    #[ignore = "network: downloads Intel's runtime archive into OPENVINO_INSTALL_DATA"]
    async fn installs_the_catalogs_runtime_from_intel() {
        let data = PathBuf::from(std::env::var_os("OPENVINO_INSTALL_DATA").expect("OPENVINO_INSTALL_DATA: a scratch data folder"));
        let entry = {
            let _catalog = crate::model_catalog::testing::built_in_catalog();
            runtime_entry().expect("the built-in catalog pins a runtime for this build")
        };
        let root = runtimes::root_in(&data, OPENVINO_GENAI);
        let started = Instant::now();
        let mut shown = 0;
        let dir = runtimes::install_into(&runtimes::Fetch::Vendor, &root, &entry, &CancellationToken::new(), |done, total| {
            if done - shown >= 32 << 20 || done == total {
                shown = done;
                eprintln!("{} of {} MB", done >> 20, total >> 20);
            }
        })
        .await
        .unwrap();
        eprintln!("installed {} {} in {} in {:.0} s", entry.name, entry.version, dir.display(), started.elapsed().as_secs_f64());
        let installed = runtimes::installed_in(&root);
        assert_eq!(installed.first().map(|version| &version.dir), Some(&dir));
        assert_eq!(installed[0].record.size(), entry.installed_size());
        let leftovers: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().map(|item| item.file_name()).collect();
        assert_eq!(leftovers, [std::ffi::OsString::from(&entry.version)]);
        crate::whisper_engine::openvino::genai::GenAi::load(&dir).expect("the installed runtime loads");
    }

    #[tokio::test]
    async fn a_cancel_while_the_runtime_downloads_leaves_neither_installed() {
        let (hub, _) = hub_with_model();
        let hub = hub.serve().await;
        let data = tempfile::tempdir().unwrap();
        let place = test_place(data.path(), &hub.url);
        let entry = companion_entry();
        let offered = runtime_entry_served("2026.4.1.0", 3, API_LEVEL).await;
        let cancel = CancellationToken::new();
        let error = install_both(&place, Ok(&offered), &entry, &cancel, |_, _| cancel.cancel()).await.unwrap_err();
        assert_eq!(error.to_string(), CANCELLED);
        assert!(runtimes::installed_in(&place.runtime_root).is_empty());
        assert_eq!(std::fs::read_dir(&place.runtime_root).unwrap().count(), 0);
        assert!(installed::read_record(&installed::record_path_for_dir(&dir_in(&place.models, &entry))).is_none());

        // A runtime this build cannot run is refused before anything is fetched.
        let error = install_both(&place, Err("no runtime".to_string()), &entry, &CancellationToken::new(), |_, _| {}).await.unwrap_err();
        assert_eq!(error.to_string(), "no runtime");
    }
}
