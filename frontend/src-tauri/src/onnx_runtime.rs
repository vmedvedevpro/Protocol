//! One ONNX Runtime environment for the speech models: CPU VAD, Parakeet and
//! Pyannote, DirectML diarization on Windows. Windows and Linux load the
//! packaged runtime by absolute path; do not search PATH or the system library
//! path, and do not accept an environment-selected library for the desktop app.
//! macOS links the runtime ort downloads at build time.

pub const START_ERROR_CODE: &str = "TRANSCRIPTION_RUNTIME_INITIALIZATION_FAILED";

#[derive(Debug, thiserror::Error)]
#[error("Speech recognition could not initialize: {0}")]
pub struct InitializationError(#[source] pub anyhow::Error);

// ort allows one environment per process, and every session is built from it.
// Like ort's own global before rc.14, it lives until the process exits.
static ENVIRONMENT: std::sync::OnceLock<Result<ort::environment::Environment, String>> =
    std::sync::OnceLock::new();

#[cfg(windows)]
const RUNTIME_FILE: &str = "onnxruntime.dll";
#[cfg(target_os = "linux")]
const RUNTIME_FILE: &str = "libonnxruntime.so";

#[cfg(any(windows, target_os = "linux"))]
static RUNTIME_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
#[cfg(windows)]
static DIRECTML: std::sync::OnceLock<libloading::Library> = std::sync::OnceLock::new();

#[cfg(any(windows, target_os = "linux"))]
pub fn initialize<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let resource = std::path::Path::new("binaries/onnxruntime").join(RUNTIME_FILE);
    if let Ok(path) = app.path().resolve(resource, tauri::path::BaseDirectory::Resource) {
        let _ = RUNTIME_PATH.set(path);
    }
    if let Err(error) = ensure_available() {
        log::error!("Bundled ONNX Runtime unavailable: {error}");
    }
}

pub fn ensure_available() -> anyhow::Result<()> {
    environment().map(|_| ())
}

/// The environment to build ONNX sessions from; loads the runtime on first use.
pub fn environment() -> anyhow::Result<&'static ort::environment::Environment> {
    ENVIRONMENT
        .get_or_init(|| {
            #[cfg(any(windows, target_os = "linux"))]
            {
                let path = RUNTIME_PATH.get_or_init(|| {
                    #[cfg(test)]
                    { std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/onnxruntime").join(RUNTIME_FILE) }
                    #[cfg(not(test))]
                    { std::env::current_exe().unwrap_or_default().with_file_name("binaries").join("onnxruntime").join(RUNTIME_FILE) }
                });
                initialize_library(path)
            }
            #[cfg(not(any(windows, target_os = "linux")))]
            {
                let environment = ort::init().with_telemetry(false).build().map_err(|error| error.to_string())?;
                log::info!("Initialized ONNX Runtime: {}", ort::info());
                Ok(environment)
            }
        })
        .as_ref()
        .map_err(|error| anyhow::anyhow!("{error}"))
}

/// A session builder for the app's models; every session starts here.
///
/// - PreferCPU: ort gives every builder ONNX Runtime's MaxEfficiency device
///   policy, under which a session that registers no execution provider may be
///   placed on an NPU or CoreML. ort's CPU provider registers none (it only
///   switches the memory arena), so CPU sessions name the CPU here. A provider
///   a session does register (DirectML) still takes precedence.
/// - No spinning: since 1.23, ONNX Runtime's idle worker threads spin with
///   TPAUSE on Intel CPUs that have it. On a hybrid Core Ultra that made
///   Parakeet about four times slower than 1.22 with spinning; without it,
///   both versions are faster (#70). pyke's ort builds have done the same
///   since rc.11 for client apps.
pub fn session_builder(
    environment: &ort::environment::Environment,
) -> ort::Result<ort::session::builder::SessionBuilder> {
    Ok(ort::session::Session::builder(environment)?
        .with_auto_device(ort::session::builder::AutoDevicePolicy::PreferCPU)?
        .with_intra_op_spinning(false)?
        .with_inter_op_spinning(false)?)
}

#[cfg(any(windows, target_os = "linux"))]
fn initialize_library(path: &std::path::Path) -> Result<ort::environment::Environment, String> {
    if !path.is_absolute() || !path.is_file() {
        return Err("The bundled ONNX Runtime is missing. Repair or reinstall Protocol, then restart it.".into());
    }
    // Keep the app-owned DirectML dependency loaded by absolute path for the
    // lifetime of ORT. Never resolve a different DirectML.dll from PATH.
    // SAFETY: the build/package validator pins this app-owned native library;
    // no function or pointer from it is used here.
    #[cfg(windows)]
    {
        let directml_path = path.with_file_name("DirectML.dll");
        if directml_path.is_file() && DIRECTML.get().is_none() {
            match unsafe { libloading::Library::new(&directml_path) } {
                Ok(library) => { let _ = DIRECTML.set(library); }
                Err(error) => log::warn!("DirectML unavailable; speech models can use CPU: {error}"),
            }
        }
    }
    // init_from returns the loader's errors (a missing dependency, a wrong
    // file) and refuses a runtime older than ort's API level without keeping
    // it loaded. ort still asserts on a malformed library (OrtGetApiBase
    // returning null); the catch_unwind keeps that a recoverable error too.
    let environment = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ort::init_from(path)
            .map_err(|error| format!("Cannot load bundled ONNX Runtime: {error}. Repair/reinstall and restart Protocol."))?
            .with_telemetry(false)
            .build()
            .map_err(|error| error.to_string())
    }))
    .map_err(|_| "ONNX Runtime initialization failed. Repair/reinstall and restart Protocol.".to_string())??;
    let version = runtime_version(path).unwrap_or_else(|| "(version unknown)".into());
    log::info!("Initialized verified bundled ONNX Runtime {version}: {}", ort::info());
    Ok(environment)
}

/// The release the loaded runtime reports, such as 1.24.4. ort::info() of
/// Microsoft's builds names only the git branch (HEAD) and commit.
#[cfg(any(windows, target_os = "linux"))]
fn runtime_version(path: &std::path::Path) -> Option<String> {
    // SAFETY: ort already loaded this verified library and keeps it loaded, so
    // this only takes another reference to it; OrtGetApiBase and
    // GetVersionString take no arguments and return static data, copied out
    // before the reference is dropped.
    unsafe {
        let library = libloading::Library::new(path).ok()?;
        let get_api_base = library
            .get::<unsafe extern "system" fn() -> *const ort::sys::OrtApiBase>(b"OrtGetApiBase\0")
            .ok()?;
        let api_base = get_api_base().as_ref()?;
        let version = std::ffi::CStr::from_ptr((api_base.GetVersionString)());
        version.to_str().ok().map(str::to_owned)
    }
}

#[tauri::command]
pub async fn check_transcription_runtime() -> Result<(), String> {
    ensure_available().map_err(|error| format!("{START_ERROR_CODE}: {error}"))
}

#[cfg(all(test, any(windows, target_os = "linux")))]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    #[ignore = "Requires MEETILY_PARAKEET_TEST_MODEL and MEETILY_NEMOTRON_WAV"]
    fn directml_runtime_preserves_cpu_vad_and_parakeet() {
        ensure_available().unwrap();
        let path = std::env::var("MEETILY_PARAKEET_TEST_MODEL").expect("Set Parakeet model directory");
        let wav = std::env::var("MEETILY_NEMOTRON_WAV").expect("Set speech WAV");
        let (mut audio, rate) = crate::diarization::dsp::read_wav(std::path::Path::new(&wav)).unwrap();
        assert_eq!(rate, 16000);
        audio.truncate(16000 * 16);
        let mut vad = crate::audio::vad::ContinuousVadProcessor::new(16000, 800).unwrap();
        let mut segments = vad.process_audio(&audio).unwrap();
        segments.extend(vad.flush().unwrap());
        assert!(!segments.is_empty(), "VAD lost speech under DirectML-enabled runtime");
        let mut model = crate::parakeet_engine::model::ParakeetModel::new(path, true).unwrap();
        let result = model.transcribe_samples(audio, None).unwrap();
        assert!(result.text.to_lowercase().contains("meeting"), "Unexpected Parakeet output: {}", result.text);
        println!("CPU VAD and Parakeet passed: {}", result.text);
    }
    #[test]
    fn missing_runtime_is_a_recoverable_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(initialize_library(&dir.path().join(RUNTIME_FILE)).unwrap_err().contains("missing"));
    }
    #[test]
    fn bundled_runtime_initialization_is_shared_and_idempotent() {
        ensure_available().unwrap();
        let environment = environment().unwrap();
        assert!(std::ptr::eq(environment, super::environment().unwrap()));
        assert!(ort::session::Session::builder(environment).is_ok());
        assert_eq!(runtime_version(RUNTIME_PATH.get().unwrap()).as_deref(), Some("1.24.4"));
    }

    #[test]
    fn bundled_diarization_models_run_with_shared_runtime() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/diarization");
        let mut models = crate::diarization::models::DiarizationModels::load(&path).unwrap();
        let waveform: Vec<f32> = (0..160_000).map(|sample| (sample as f32 * 0.07).sin() * 0.01).collect();
        assert!(!models.segment_window(&waveform).unwrap().is_empty());
        let embedding = models.embed(&waveform[..48_000]).unwrap();
        assert_eq!(embedding.len(), 128);
        assert!(embedding.iter().all(|value| value.is_finite()));
    }

    #[tokio::test]
    async fn failed_runtime_does_not_create_recording_storage() {
        const SCENARIO: &str = "MEETILY_TEST_MISSING_ONNX";
        if std::env::var_os(SCENARIO).is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "onnx_runtime::tests::failed_runtime_does_not_create_recording_storage", "--nocapture"])
                .env(SCENARIO, "1").status().unwrap();
            assert!(result.success());
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        RUNTIME_PATH.set(dir.path().join("missing").join(RUNTIME_FILE)).unwrap();
        let recordings = dir.path().join("recordings");
        let mut manager = crate::audio::recording_manager::RecordingManager::new();
        manager.set_recordings_folder(recordings.clone());
        manager.set_meeting_name(Some("Startup failure test".into()));
        let result = manager.start_recording(None, None, true, None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().downcast_ref::<InitializationError>().is_some());
        assert!(!recordings.exists());
        assert!(!manager.get_state().is_recording());
    }
}
