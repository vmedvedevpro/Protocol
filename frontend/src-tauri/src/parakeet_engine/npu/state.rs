//! The NPU's state (#66): what Settings shows (`parakeet_npu_status`, the
//! `parakeet-npu-status` event, the contract with #88), the one-time
//! preparation, and the encoder a Parakeet model load gets.
//!
//! The state is derived on each ask from what is on disk and what this
//! process did ([`decide`]): an Intel NPU is present (`detect`), the runtime
//! version this process uses has the NPU files, Parakeet v3 is installed,
//! and then the preparation's outcome.
//!
//! **Preparation** compiles v3's encoder for the NPU into OpenVINO's cache
//! under `<data>/cache/openvino/parakeet-npu/<key>/`, the key naming the
//! runtime version, the encoder's pinned hash and the NPU driver's and
//! compiler's versions: a change of any of them compiles again. It runs once,
//! in the background ([`kick`]), postponed while a recording or another
//! engine job runs, and holds the busy registry (`ModelCompile`): about 80 s
//! of the driver compiler's CPU time, 1.2 GB of cache. A first inference
//! checks the compiled encoder; then a `prepared` marker in the key folder
//! makes later starts `ready` after one device query. A failure leaves
//! `failed.txt` there with the reason, so a driver that cannot compile is
//! not tried at every start; `parakeet_npu_retry` clears it.
//!
//! **Use**: a Parakeet v3 load while the state is `ready` compiles from the
//! cache (about 1.5 s) and checks one inference ([`encoder_for_load`]);
//! otherwise, and on any failure, Parakeet runs on the processor. A model
//! loaded before the preparation finished moves to the NPU at its next load,
//! never mid-recording.
//!
//! **Removal**: the NPU cache goes with Parakeet v3 ([`model_removed`]) and
//! with the runtime ([`runtime_removed`]). On a PC with an NPU and v3, the
//! runtime stays installed even when no Whisper companion uses it
//! ([`keeps_runtime`]).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

use super::guard::{self, Step};
use super::openvino::OpenVino;
use super::{detect, NpuEncoder};
use crate::model_catalog::{self, installed, schema::Engine};
use crate::updater::busy::{self, BusyReason};

/// Sent with the status on every change.
pub const STATUS_EVENT: &str = "parakeet-npu-status";
/// The Parakeet model the NPU runs.
pub const MODEL_ID: &str = "parakeet-tdt-0.6b-v3-int8";
/// The files the NPU needs in a runtime beside those Whisper uses.
pub const RUNTIME_FILES: [&str; 2] = ["openvino_intel_npu_plugin.dll", "openvino_onnx_frontend.dll"];
/// The encoder the NPU runs, in the model's folder.
pub const ENCODER: &str = "encoder-model.int8.onnx";
const PREPARED: &str = "prepared";
const FAILED: &str = "failed.txt";
/// How often a postponed preparation looks again.
const WAIT: Duration = Duration::from_secs(2);

/// What Settings shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NpuState {
    Absent,
    NeedsRuntime,
    NeedsModel,
    Waiting,
    Preparing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ParakeetNpuStatus {
    pub present: bool,
    pub state: NpuState,
    /// The loaded Parakeet model encodes on the NPU now.
    pub active: bool,
    /// `failed`: a short technical reason.
    pub reason: Option<String>,
}

/// What is on disk and on the PC, read for each status.
#[derive(Debug, Clone, Copy, Default)]
struct Facts {
    present: bool,
    runtime: bool,
    model: bool,
}

/// What this process did.
#[derive(Debug, Default)]
struct Progress {
    /// The key folder of a preparation done or found.
    prepared: Option<PathBuf>,
    failed: Option<String>,
    preparing: bool,
    active: bool,
}

static PROGRESS: Mutex<Progress> = Mutex::new(Progress { prepared: None, failed: None, preparing: false, active: false });
static JOB: AtomicBool = AtomicBool::new(false);
static EMIT: OnceLock<Box<dyn Fn(&ParakeetNpuStatus) + Send + Sync>> = OnceLock::new();

fn progress() -> std::sync::MutexGuard<'static, Progress> {
    PROGRESS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The state from the facts, this process's progress and a crash marker.
fn decide(facts: Facts, progress: &Progress, stopped: Option<String>) -> ParakeetNpuStatus {
    let status = |state, reason| ParakeetNpuStatus { present: facts.present, state, active: progress.active, reason };
    if !facts.present {
        return ParakeetNpuStatus { present: false, state: NpuState::Absent, active: false, reason: None };
    }
    if !facts.runtime {
        return status(NpuState::NeedsRuntime, None);
    }
    if !facts.model {
        return status(NpuState::NeedsModel, None);
    }
    if let Some(reason) = stopped.or_else(|| progress.failed.clone()) {
        return status(NpuState::Failed, Some(reason));
    }
    if progress.preparing {
        status(NpuState::Preparing, None)
    } else if progress.prepared.is_some() {
        status(NpuState::Ready, None)
    } else {
        status(NpuState::Waiting, None)
    }
}

/// Whether the runtime record in `dir` holds the NPU files.
fn has_npu_files(dir: &Path) -> bool {
    model_catalog::runtime::verified(dir)
        .is_some_and(|record| RUNTIME_FILES.iter().all(|name| record.files.iter().any(|file| file.name == *name)))
}

/// The runtime folder a load would take now. The process may have pinned an
/// older version meanwhile (a new one was installed while it ran): [`api`]
/// then fails with the reason, and the next start takes the new one.
fn runtime_dir() -> Option<PathBuf> {
    model_catalog::openvino::runtime_to_load()
        .ok()
        .map(|installed| installed.dir)
        .or_else(crate::whisper_engine::openvino::loaded_runtime_dir)
}

/// Parakeet v3's folder.
fn model_dir() -> PathBuf {
    crate::paths::models_dir().join("parakeet").join(MODEL_ID)
}

/// The encoder's pinned SHA-256 when v3 is installed: every file of its
/// installed version there with its size.
fn installed_encoder() -> Option<&'static str> {
    let entry = model_catalog::entry(Engine::Parakeet, MODEL_ID)?;
    let dir = model_dir();
    let expected = installed::expected(&entry, &installed::record_path_for_dir(&dir))?;
    let complete = expected
        .files
        .iter()
        .all(|pinned| std::fs::metadata(dir.join(pinned.file)).is_ok_and(|meta| meta.len() == pinned.size));
    complete.then(|| expected.files.iter().find(|pinned| pinned.file == ENCODER).map(|pinned| pinned.sha256)).flatten()
}

fn facts() -> Facts {
    let present = detect::present();
    Facts {
        present,
        runtime: present && runtime_dir().is_some_and(|dir| has_npu_files(&dir)),
        model: present && installed_encoder().is_some(),
    }
}

/// The status now.
pub fn status() -> ParakeetNpuStatus {
    let facts = facts();
    let stopped = if facts.present { guard::stopped() } else { None };
    decide(facts, &progress(), stopped)
}

fn emit() {
    if let Some(emit) = EMIT.get() {
        emit(&status());
    }
}

/// Where the app sends [`STATUS_EVENT`]; set once at startup.
pub fn set_app<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    use tauri::Emitter;
    let _ = EMIT.set(Box::new(move |status| {
        let _ = app.emit(STATUS_EVENT, status);
    }));
}

/// Whether the NPU keeps Intel's runtime installed: an Intel NPU and
/// Parakeet v3 are here (`model_catalog::openvino` prunes it otherwise once
/// no Whisper companion keeps it).
pub fn keeps_runtime() -> bool {
    detect::present() && installed_encoder().is_some()
}

/// Whether the Labs DirectML toggle is overruled: the NPU is being
/// prepared or ready, and Parakeet's encoder belongs to it (or to the
/// processor meanwhile).
pub fn overrides_labs() -> bool {
    matches!(status().state, NpuState::Preparing | NpuState::Ready)
}

// --- The runtime and the device ------------------------------------------

/// OpenVINO's C API and the runtime version, loaded once per process from
/// the folder the process pinned (`whisper_engine::openvino::pin_runtime`).
/// A runtime not installed is looked for again on the next call; a load,
/// failed or not, is kept.
fn api() -> Result<(&'static OpenVino, String), String> {
    static API: Mutex<Option<Result<(&'static OpenVino, String), String>>> = Mutex::new(None);
    let mut slot = API.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(outcome) = slot.as_ref() {
        return outcome.clone();
    }
    let (dir, version) = crate::whisper_engine::openvino::pin_runtime()?;
    if !has_npu_files(&dir) {
        return Err(format!("Intel's libraries {version} in use lack the NPU files; restart Protocol after downloading them"));
    }
    let outcome = guard::guarded(Step::Load, || OpenVino::load(&dir))?
        .map(|api| (&*Box::leak(Box::new(api)), version.clone()))
        .map_err(|error| format!("OpenVINO {version} could not be loaded: {error}"));
    match &outcome {
        Ok(_) => log::info!("[npu] loaded OpenVINO's C API {version} from {}", dir.display()),
        Err(error) => log::error!("[npu] {error}"),
    }
    *slot = Some(outcome.clone());
    outcome
}

/// The NPU as its plugin reports it.
#[derive(Debug, Clone)]
struct Device {
    name: String,
    driver: String,
    compiler: String,
}

fn device(api: &'static OpenVino) -> Result<Device, String> {
    guard::guarded(Step::Device, || {
        let core = api.core().map_err(|error| error.to_string())?;
        // The plugin lists the NPUs it can drive by their architecture.
        let available = core.property(super::DEVICE, "AVAILABLE_DEVICES").unwrap_or_default();
        if available.trim().is_empty() {
            return Err("OpenVINO's NPU plugin finds no NPU it can use (is the NPU driver installed?)".to_string());
        }
        let read = |key: &str| core.property(super::DEVICE, key).unwrap_or_else(|| "unknown".to_string());
        Ok(Device { name: read("FULL_DEVICE_NAME"), driver: read("NPU_DRIVER_VERSION"), compiler: read("NPU_COMPILER_VERSION") })
    })?
}

/// The NPU's caches, one folder per [`cache_key`].
pub fn cache_root() -> PathBuf {
    crate::whisper_engine::openvino::cache_root().join(crate::whisper_engine::openvino::NPU_CACHE)
}

fn cache_key(runtime: &str, encoder_sha256: &str, device: &Device) -> String {
    let encoder: String = encoder_sha256.chars().take(12).collect();
    let safe = |value: &str| value.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' { c } else { '-' }).collect::<String>();
    format!("{}_{encoder}_{}_{}", safe(runtime), safe(&device.driver), safe(&device.compiler))
}

/// The compile options: OpenVINO's cache, and the NPU driver's compiler (the
/// runtime carries no compiler of its own; an old driver that cannot compile
/// fails the preparation with its reason).
fn compile(api: &'static OpenVino, encoder: &Path, cache: &Path) -> Result<NpuEncoder, String> {
    guard::guarded(Step::Compile, || NpuEncoder::compile(api, encoder, Some(cache)))?
        .map_err(|error| format!("compiling Parakeet's encoder for the NPU failed: {error}"))
}

/// One inference of silence: the compiled encoder runs and gives frames.
fn first_run(encoder: &mut NpuEncoder) -> Result<(), String> {
    let silence = ndarray::Array3::<f32>::zeros((1, super::FEATURES, super::FRAMES));
    let (out, frames) = guard::guarded(Step::FirstRun, || encoder.encode(&silence.view(), super::FRAMES as i64))?
        .map_err(|error| format!("the first inference on the NPU failed: {error}"))?;
    if frames == 0 || out.iter().any(|value| !value.is_finite()) {
        return Err(format!("the first inference on the NPU gave {frames} frames or values that are not numbers"));
    }
    Ok(())
}

// --- Preparation -----------------------------------------------------------

/// Work that must not share the machine with a preparation: anything but a
/// model download or onboarding (as `model_catalog::openvino`).
fn engines_busy() -> bool {
    busy::current().into_iter().any(|reason| !matches!(reason, BusyReason::ModelDownload | BusyReason::Onboarding))
}

/// Records a failure for this process and, keyed, for later starts.
fn fail(reason: String, key_dir: Option<&Path>) {
    log::error!("[npu] {reason}; Parakeet runs on the processor");
    if let Some(dir) = key_dir {
        let _ = std::fs::create_dir_all(dir).and_then(|()| std::fs::write(dir.join(FAILED), &reason));
    }
    let mut progress = progress();
    progress.failed = Some(reason);
    progress.preparing = false;
}

/// Starts the preparation in the background when it is due and not running;
/// it ends by itself when there is nothing to do. Call it at startup and
/// whenever the runtime or Parakeet v3 is installed.
pub fn kick() {
    if JOB.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        prepare_when_due().await;
        JOB.store(false, Ordering::SeqCst);
        emit();
    });
}

/// The runtime, Parakeet v3 or the retry changed what the NPU can do.
pub fn changed() {
    emit();
    kick();
}

async fn prepare_when_due() {
    loop {
        if status().state != NpuState::Waiting {
            return;
        }
        let Some(encoder_sha256) = installed_encoder() else { return };
        let checked = tokio::task::spawn_blocking(|| api().and_then(|(api, version)| device(api).map(|device| (api, version, device)))).await;
        let (api, version, device) = match checked {
            Ok(Ok(found)) => found,
            Ok(Err(reason)) => return fail(reason, None),
            Err(error) => return fail(format!("the NPU check stopped: {error}"), None),
        };
        let key_dir = cache_root().join(cache_key(&version, encoder_sha256, &device));
        if key_dir.join(PREPARED).is_file() {
            log::info!("[npu] {} is prepared ({})", device.name, key_dir.display());
            progress().prepared = Some(key_dir);
            return;
        }
        if let Ok(reason) = std::fs::read_to_string(key_dir.join(FAILED)) {
            let mut progress = progress();
            progress.failed = Some(reason);
            return;
        }
        if engines_busy() {
            tokio::time::sleep(WAIT).await;
            continue;
        }
        progress().preparing = true;
        emit();
        log::info!("[npu] preparing Parakeet for {} (driver {}, compiler {})", device.name, device.driver, device.compiler);
        let encoder = model_dir().join(ENCODER);
        let dir = key_dir.clone();
        let prepared = tokio::task::spawn_blocking(move || {
            let _busy = busy::hold(BusyReason::ModelCompile);
            std::fs::create_dir_all(&dir).map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
            let started = std::time::Instant::now();
            let mut compiled = compile(api, &encoder, &dir)?;
            first_run(&mut compiled)?;
            Ok::<f64, String>(started.elapsed().as_secs_f64())
        })
        .await
        .unwrap_or_else(|error| Err(format!("the preparation stopped: {error}")));
        match prepared {
            Ok(seconds) => {
                log::info!("[npu] prepared in {seconds:.0} s");
                if let Err(error) = std::fs::write(key_dir.join(PREPARED), b"") {
                    log::warn!("[npu] cannot mark {} prepared: {error}; it is checked again at the next start", key_dir.display());
                }
                prune_cache(&key_dir);
                {
                    let mut progress = progress();
                    progress.preparing = false;
                    progress.prepared = Some(key_dir);
                }
                emit();
                unload_parakeet_if_idle().await;
            }
            Err(reason) => fail(reason, Some(&key_dir)),
        }
        return;
    }
}

/// Removes the NPU caches other than `keep`'s.
fn prune_cache(keep: &Path) {
    let Ok(read) = std::fs::read_dir(cache_root()) else { return };
    for item in read.flatten() {
        if item.path() != keep {
            match std::fs::remove_dir_all(item.path()) {
                Ok(()) => log::info!("[npu] removed the stale cache {}", item.path().display()),
                Err(error) => log::warn!("[npu] cannot remove {}: {error}", item.path().display()),
            }
        }
    }
}

/// Unloads the speech engines when nothing uses them, so the next load puts
/// Parakeet's encoder on the NPU.
async fn unload_parakeet_if_idle() {
    if engines_busy() {
        return;
    }
    let _guard = crate::audio::common::acquire_engine_lifecycle_lock().await;
    if !engines_busy() {
        crate::audio::common::unload_both_stt_engines().await;
    }
}

// --- Use -----------------------------------------------------------------

/// The NPU encoder for a load of the Parakeet model `model_id` from
/// `model_dir`, when the NPU is ready for it; `None` otherwise (the
/// processor). Blocking: about 1.5 s from the cache. A failure is recorded
/// (state `failed`) and the load goes on without the NPU.
pub fn encoder_for_load(model_id: &str, model_dir: &Path) -> Option<NpuEncoder> {
    if model_id != MODEL_ID || status().state != NpuState::Ready {
        return None;
    }
    let key_dir = progress().prepared.clone()?;
    let loaded = api().and_then(|(api, _)| {
        let mut encoder = compile(api, &model_dir.join(ENCODER), &key_dir)?;
        first_run(&mut encoder)?;
        Ok(encoder)
    });
    match loaded {
        Ok(encoder) => {
            log::info!("[npu] Parakeet's encoder runs on the NPU");
            Some(encoder)
        }
        Err(reason) => {
            fail(reason, Some(&key_dir));
            emit();
            None
        }
    }
}

/// The kit's NPU encoder (`crate::measure`): `model_dir`'s encoder compiled
/// into `cache` from the runtime the process pins (`MEASURE_OPENVINO_RUNTIME`
/// in tests), outside the preparation and its state.
#[cfg(test)]
pub fn encoder_for_kit(model_dir: &Path, cache: &Path) -> Result<NpuEncoder, String> {
    let (api, _) = api()?;
    std::fs::create_dir_all(cache).map_err(|error| format!("cannot create {}: {error}", cache.display()))?;
    let mut encoder = compile(api, &model_dir.join(ENCODER), cache)?;
    first_run(&mut encoder)?;
    Ok(encoder)
}

/// The loaded model's encoder moved to the NPU, or left it.
pub fn set_active(active: bool) {
    let changed = {
        let mut progress = progress();
        std::mem::replace(&mut progress.active, active) != active
    };
    if changed {
        emit();
    }
}

/// An inference on the NPU failed while Parakeet ran: it goes on on the
/// processor, and the state says why.
pub fn failed_while_running(reason: String) {
    let key_dir = progress().prepared.clone();
    fail(reason, key_dir.as_deref());
    set_active(false);
    emit();
}

// --- Removal and retry -----------------------------------------------------

fn remove_cache() {
    let root = cache_root();
    match std::fs::remove_dir_all(&root) {
        Ok(()) => log::info!("[npu] removed the cache {}", root.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("[npu] cannot remove {}: {error}", root.display()),
    }
    let mut progress = progress();
    progress.prepared = None;
    progress.failed = None;
}

/// Parakeet `model_id` was deleted: v3 takes the NPU cache with it.
pub fn model_removed(model_id: &str) {
    if model_id == MODEL_ID {
        remove_cache();
        emit();
    }
}

/// Intel's runtime was removed (or is pruned at startup): the NPU cache goes.
pub fn runtime_removed() {
    remove_cache();
    emit();
}

#[tauri::command]
pub fn parakeet_npu_status() -> ParakeetNpuStatus {
    let status = status();
    if status.state == NpuState::Waiting {
        // A preparation due and not running (installed by another path).
        kick();
    }
    status
}

/// Clears `failed` (the crash marker and the recorded reasons) and prepares
/// again.
#[tauri::command]
pub fn parakeet_npu_retry() -> ParakeetNpuStatus {
    guard::retry();
    if let Ok(read) = std::fs::read_dir(cache_root()) {
        for item in read.flatten() {
            let _ = std::fs::remove_file(item.path().join(FAILED));
        }
    }
    progress().failed = None;
    log::info!("[npu] retrying the NPU");
    changed();
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(present: bool, runtime: bool, model: bool) -> Facts {
        Facts { present, runtime, model }
    }

    #[test]
    fn the_state_follows_the_device_the_installs_and_the_preparation() {
        let idle = Progress::default();
        let state = |facts, progress: &Progress, stopped: Option<&str>| decide(facts, progress, stopped.map(str::to_string)).state;
        assert_eq!(state(facts(false, true, true), &idle, None), NpuState::Absent);
        assert!(!decide(facts(false, true, true), &idle, None).present);
        assert_eq!(state(facts(true, false, true), &idle, None), NpuState::NeedsRuntime);
        assert_eq!(state(facts(true, true, false), &idle, None), NpuState::NeedsModel);
        assert_eq!(state(facts(true, true, true), &idle, None), NpuState::Waiting);

        let preparing = Progress { preparing: true, ..Progress::default() };
        assert_eq!(state(facts(true, true, true), &preparing, None), NpuState::Preparing);
        let ready = Progress { prepared: Some(PathBuf::from("key")), active: true, ..Progress::default() };
        let status = decide(facts(true, true, true), &ready, None);
        assert_eq!((status.state, status.active, status.reason), (NpuState::Ready, true, None));

        // A failure, or a crash marker, wins over the preparation, but not
        // over a missing install: removing v3 says so.
        let failed = Progress { failed: Some("old driver".to_string()), prepared: Some(PathBuf::from("key")), ..Progress::default() };
        let status = decide(facts(true, true, true), &failed, None);
        assert_eq!((status.state, status.reason.as_deref()), (NpuState::Failed, Some("old driver")));
        assert_eq!(state(facts(true, true, true), &ready, Some("crashed")), NpuState::Failed);
        assert_eq!(state(facts(true, true, false), &failed, None), NpuState::NeedsModel);
    }

    #[test]
    fn the_status_serializes_as_the_contract_says() {
        let status = ParakeetNpuStatus { present: true, state: NpuState::NeedsRuntime, active: false, reason: None };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({ "present": true, "state": "needs_runtime", "active": false, "reason": null })
        );
    }

    #[test]
    fn the_cache_key_names_the_runtime_the_encoder_and_the_npus_versions() {
        let device = Device { name: "Intel(R) AI Boost".to_string(), driver: "1005540".to_string(), compiler: "524291".to_string() };
        let key = cache_key("2026.4.1.0", "aabbccddeeff00112233", &device);
        assert_eq!(key, "2026.4.1.0_aabbccddeeff_1005540_524291");
        let odd = Device { driver: "32.0/100 5540".to_string(), ..device };
        assert_eq!(cache_key("2026.4.1.0", "aabbccddeeff", &odd), "2026.4.1.0_aabbccddeeff_32.0-100-5540_524291");
    }
}
