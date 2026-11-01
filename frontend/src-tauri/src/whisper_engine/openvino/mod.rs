//! Whisper on OpenVINO GenAI, for the Intel GPU whisper.cpp would otherwise run
//! on through Vulkan (#79). On an Arc B390, with the kit on `fleurs-ru`, GenAI's
//! `WhisperPipeline` ran Large V3 Turbo about four times faster than
//! whisper.cpp 1.8.3 on Vulkan, live and after meetings, for about a quarter
//! of the package energy, at the same word error rate.
//!
//! - The runtime ([`genai`]) is loaded on first use from `binaries/openvino/`
//!   and stays loaded for the process, like ONNX Runtime; the app starts, and
//!   whisper.cpp runs, without it.
//! - [`device`] decides whether the GPU whisper.cpp would pick is an Intel GPU
//!   that OpenVINO can take over.
//! - [`OpenVinoWhisper`] owns one pipeline (an encoder and a stateful decoder
//!   compiled for that GPU). `WhisperEngine` holds it in place of a whisper.cpp
//!   context and drops it on unload, on a model switch and at exit.

pub mod device;
pub mod genai;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{anyhow, Result};

use crate::audio::post_meeting::VAD_REDEMPTION_TIME_MS;
use crate::audio::vad::{self, ContinuousSpeechCap};
use crate::updater::busy::{self, BusyReason};
use genai::{GenAi, GenerationConfig, Pipeline};

use super::{TimedText, WhisperEngine};

/// The files of an OpenVINO Whisper model folder that GenAI reads (an
/// `optimum-intel` export, as `OpenVINO/whisper-*-ov` on Hugging Face has it).
pub const MODEL_FILES: &[&str] = &[
    "openvino_encoder_model.xml",
    "openvino_encoder_model.bin",
    "openvino_decoder_model.xml",
    "openvino_decoder_model.bin",
    "openvino_tokenizer.xml",
    "openvino_tokenizer.bin",
    "openvino_detokenizer.xml",
    "openvino_detokenizer.bin",
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
];

/// True when `dir` holds an OpenVINO Whisper model.
pub fn is_model_dir(dir: &Path) -> bool {
    MODEL_FILES.iter().all(|file| dir.join(file).is_file())
}

static RUNTIME_DIR: OnceLock<PathBuf> = OnceLock::new();
static RUNTIME: OnceLock<std::result::Result<GenAi, String>> = OnceLock::new();

/// Records where the bundled runtime is; called from setup with the app's
/// resource folder. Loading waits for the first OpenVINO model.
pub fn initialize<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    match app.path().resolve("binaries/openvino", tauri::path::BaseDirectory::Resource) {
        Ok(path) => {
            let _ = RUNTIME_DIR.set(path);
        }
        Err(error) => log::warn!("Cannot resolve the bundled OpenVINO runtime in the app's resources: {error}"),
    }
}

fn runtime_dir() -> &'static Path {
    RUNTIME_DIR.get_or_init(|| {
        #[cfg(test)]
        {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/openvino")
        }
        #[cfg(not(test))]
        {
            std::env::current_exe().unwrap_or_default().with_file_name("binaries").join("openvino")
        }
    })
}

/// The process's runtime, loaded on first use. A failed load is kept: the
/// files do not change while the app runs.
pub fn runtime() -> Result<&'static GenAi> {
    RUNTIME
        .get_or_init(|| {
            let dir = runtime_dir();
            if !dir.join(genai::GENAI_C_LIBRARY).is_file() {
                return Err(format!("the OpenVINO runtime is not installed ({} is missing)", dir.display()));
            }
            GenAi::load(dir).map_err(|error| error.to_string()).inspect(|_| {
                log::info!("Loaded the OpenVINO GenAI runtime from {}", dir.display());
            })
        })
        .as_ref()
        .map_err(|error| anyhow!("{error}"))
}

/// The OpenVINO device that takes over the GPU whisper.cpp would use, if any:
/// the rule in [`device`]. `chosen` is that GPU as ggml reports it
/// (`acceleration::whisper_gpu`). Logs which way it matched, or why not.
pub fn device_for(chosen: Option<&super::WhisperGpu>) -> Result<Option<String>> {
    let gpus: Vec<device::OpenVinoGpu> = runtime()?
        .devices()?
        .into_iter()
        .filter(|info| info.name.starts_with("GPU"))
        .map(|info| device::OpenVinoGpu {
            vendor: info.architecture.as_deref().and_then(device::vendor_from_architecture),
            pci: info.pci_info.as_deref().and_then(device::PciAddress::from_openvino),
            integrated: info.device_type.as_deref().map(|kind| kind == "integrated"),
            full_name: info.full_name,
            name: info.name,
        })
        .collect();
    let rule_input = chosen.map(|gpu| device::ChosenGpu {
        pci_bus_id: gpu.pci_bus_id.as_deref(),
        name: &gpu.name,
        integrated: gpu.integrated,
    });
    let found = device::openvino_device_for(rule_input, &gpus);
    let described = chosen.map_or_else(
        || "no GPU".to_string(),
        |gpu| format!("{} ({}, PCI {})", gpu.name, if gpu.integrated { "integrated" } else { "discrete" },
            gpu.pci_bus_id.as_deref().unwrap_or("not reported")),
    );
    match &found {
        Some((device, matched)) => log::info!("OpenVINO {device} is the GPU whisper.cpp uses, {described}: matched by {matched:?}"),
        None => log::info!(
            "Whisper stays on whisper.cpp: no Intel GPU among OpenVINO's {:?} is the GPU it uses, {described}",
            gpus.iter().map(|gpu| gpu.full_name.as_deref().unwrap_or(&gpu.name)).collect::<Vec<_>>()
        ),
    }
    Ok(found.map(|(device, _)| device))
}

/// Where compiled models are cached: OpenVINO's `CACHE_DIR`. The first load of
/// a model compiles its kernels for the GPU (about 3–7 s for Large V3 Turbo
/// on an Arc B390, 835 MB of cache); later loads read them back in under 1 s.
pub fn cache_dir() -> PathBuf {
    crate::paths::install_data_root().join("cache").join("openvino")
}

/// How one call decodes. The app's language setting maps as for whisper.cpp
/// (`decoding::language_and_translation`): `None` or "auto" detects the
/// language in the call, "auto-translate" detects it and translates to English.
#[derive(Debug, Clone, Copy)]
pub struct Call<'a> {
    pub language: Option<&'a str>,
    pub timestamps: bool,
    pub initial_prompt: Option<&'a str>,
}

/// One compiled pipeline and what it was compiled from.
pub struct OpenVinoWhisper {
    model_dir: PathBuf,
    device: String,
    /// `None` after a failed `generate`: GenAI then skips resetting the decoder
    /// state and the sampler (openvino.genai `whisper.cpp` 2026.4.1), so the
    /// pipeline would carry them into the next call. It is compiled again (from
    /// the cache) before the next call instead.
    pipeline: Mutex<Option<Pipeline<'static>>>,
}

impl OpenVinoWhisper {
    /// Compiles the model in `model_dir` for `device`. Blocking: seconds on the
    /// first load of a model, under a second from the cache. The busy registry
    /// keeps an update from restarting the app meanwhile.
    pub fn load(model_dir: &Path, device: &str) -> Result<Self> {
        let pipeline = Self::compile(model_dir, device)?;
        Ok(Self { model_dir: model_dir.to_path_buf(), device: device.to_string(), pipeline: Mutex::new(Some(pipeline)) })
    }

    fn compile(model_dir: &Path, device: &str) -> Result<Pipeline<'static>> {
        let _busy = busy::hold(BusyReason::ModelCompile);
        let api = runtime()?;
        let cache = cache_dir();
        if let Err(error) = std::fs::create_dir_all(&cache) {
            log::warn!("Cannot create the OpenVINO cache folder {}: {error}; compiling without a cache", cache.display());
        }
        let started = std::time::Instant::now();
        let pipeline = Pipeline::create(api, model_dir, device, cache.is_dir().then_some(cache.as_path()))
            .map_err(|error| anyhow!("OpenVINO could not load {} on {device}: {error}", model_dir.display()))?;
        log::info!("OpenVINO Whisper pipeline for {} on {device} ready in {:.1} s", model_dir.display(), started.elapsed().as_secs_f64());
        Ok(pipeline)
    }

    pub fn device(&self) -> &str {
        &self.device
    }

    pub fn model_dir(&self) -> &Path {
        &self.model_dir
    }

    /// Transcribes 16 kHz mono samples. Blocking; calls are serialized.
    pub fn transcribe(&self, samples: &[f32], call: Call<'_>) -> Result<genai::Transcript> {
        let mut slot = self.pipeline.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            *slot = Some(Self::compile(&self.model_dir, &self.device)?);
        }
        let pipeline = slot.as_mut().expect("compiled above");
        let config = Self::config(pipeline, call)?;
        match pipeline.generate(samples, &config) {
            Ok(transcript) => Ok(transcript),
            Err(error) => {
                drop(config);
                *slot = None;
                Err(anyhow!("OpenVINO could not transcribe {:.1} s of audio: {error}", samples.len() as f64 / 16_000.0))
            }
        }
    }

    /// A live call: greedy, no timestamps, the joined text cleaned as
    /// whisper.cpp's live text is (`clean_repetitive_text`).
    pub fn live_text(&self, samples: &[f32], language: Option<&str>, initial_prompt: Option<&str>) -> Result<String> {
        let transcript = self.transcribe(samples, Call { language, timestamps: false, initial_prompt })?;
        Ok(WhisperEngine::clean_repetitive_text(transcript.text.trim()))
    }

    /// A post-meeting piece: its segments with times from the piece start, as
    /// `PostMeetingWhisper` gives whisper.cpp's. The call gets the piece up to
    /// [`speech_end`]; a segment GenAI leaves open (end -1) ends with the piece.
    pub fn piece_segments(
        &self,
        samples: &[f32],
        language: Option<&str>,
        initial_prompt: Option<&str>,
    ) -> Result<Vec<TimedText>> {
        let heard = &samples[..speech_end(samples)];
        let piece_ms = samples.len() as f64 / 16.0;
        let transcript = self.transcribe(heard, Call { language, timestamps: true, initial_prompt })?;
        Ok(transcript
            .chunks
            .into_iter()
            .filter_map(|chunk| {
                let text = WhisperEngine::clean_repetitive_text(chunk.text.trim());
                let end_ms = if chunk.end_s < 0.0 { piece_ms } else { chunk.end_s as f64 * 1000.0 };
                (!text.is_empty()).then(|| TimedText { start_ms: chunk.start_s as f64 * 1000.0, end_ms, text })
            })
            .collect())
    }

    fn config(pipeline: &Pipeline<'static>, call: Call<'_>) -> Result<GenerationConfig<'static>> {
        let mut config = pipeline.default_config()?;
        let (language, translate) = super::decoding::language_and_translation(call.language);
        if let Some(code) = language {
            config.set_language(&format!("<|{code}|>"))?;
        }
        config.set_task(if translate { "translate" } else { "transcribe" })?;
        config.set_return_timestamps(call.timestamps)?;
        if let Some(prompt) = call.initial_prompt.filter(|prompt| !prompt.trim().is_empty()) {
            config.set_initial_prompt(prompt)?;
        }
        Ok(config)
    }
}

/// The batch VAD pads a speech segment's end by this much (`vad.rs`:
/// `post_speech_pad`, half the redemption time capped at 250 ms): Silero's
/// speech probability falls before a word's sound does (a fading vowel, a final
/// fricative), and the pad keeps that end. The OpenVINO call keeps it too.
const SPEECH_END_PAD_MS: usize = 250;

/// The most sensitive thresholds any post-meeting track uses (the microphone's
/// in `retranscription.rs`): the tail check below trims only when even they
/// find no speech in it.
const TAIL_POSITIVE_THRESHOLD: f32 = 0.20;
const TAIL_NEGATIVE_THRESHOLD: f32 = 0.10;

/// How many of a post-meeting piece's samples the OpenVINO call hears.
///
/// The batch VAD ends a segment after [`VAD_REDEMPTION_TIME_MS`] (2 s) without
/// speech and keeps that pause in the piece. Given that pause after its last
/// sentence, greedy decoding in GenAI 2026.4.1 can open one more segment and
/// copy the sentence into it (#79: a 23.7 s `fleurs-ru` piece decoded the
/// sentence ending at 21.3 s again at 23.3–23.7 s, in one encoder pass; the
/// pause alone decodes as "Спасибо."). whisper.cpp's beam search and its
/// temperature fallback, which GenAI lacks, keep the product's pass from doing
/// so. So the call ends at the last speech plus the VAD's own pad.
///
/// A piece cut at a 25 s mark (`split_segment_at_silence`) ends inside speech,
/// without that pause; so the pause is trimmed only when Silero finds no speech
/// in the piece's last 2 s.
pub fn speech_end(samples: &[f32]) -> usize {
    let pause = VAD_REDEMPTION_TIME_MS as usize * 16;
    let pad = SPEECH_END_PAD_MS * 16;
    if samples.len() <= pause + 16_000 {
        return samples.len();
    }
    let tail = &samples[samples.len() - pause..];
    match vad::get_speech_chunks_with_cap_and_progress(
        tail,
        VAD_REDEMPTION_TIME_MS,
        TAIL_POSITIVE_THRESHOLD,
        TAIL_NEGATIVE_THRESHOLD,
        ContinuousSpeechCap::PauseToPause,
        |_, _| true,
    ) {
        Ok(speech) if speech.is_empty() => samples.len() - pause + pad,
        Ok(_) => samples.len(),
        Err(error) => {
            log::warn!("Cannot check a piece's end for speech ({error}); OpenVINO hears the whole piece");
            samples.len()
        }
    }
}

/// What `WhisperEngine` holds for OpenVINO: the loaded pipeline, if any.
pub(crate) type Slot = std::sync::Arc<std::sync::RwLock<Option<std::sync::Arc<OpenVinoWhisper>>>>;

/// Which backend runs Whisper and why, for Settings (`get_local_stack_status`)
/// and the log: OpenVINO, or whisper.cpp with the reason OpenVINO is not used
/// when it was expected (a runtime, device or model failure).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub openvino_device: Option<String>,
    pub fallback_reason: Option<String>,
}

static STATUS: std::sync::Mutex<Option<BackendStatus>> = std::sync::Mutex::new(None);

/// The last backend decision of a model load, if one was made.
pub fn backend_status() -> Option<BackendStatus> {
    STATUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

fn record(status: BackendStatus) {
    *STATUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(status);
}

/// The OpenVINO part of `get_local_stack_status`: the device the loaded
/// model runs on, or why the last load fell back to whisper.cpp.
pub fn stack_status(engine: Option<&WhisperEngine>) -> serde_json::Value {
    let device = engine.and_then(WhisperEngine::loaded_openvino).map(|loaded| loaded.device().to_string());
    let fallback = backend_status().and_then(|status| status.fallback_reason).filter(|_| device.is_none());
    serde_json::json!({ "device": device, "fallbackReason": fallback })
}

/// Whether OpenVINO can take over Whisper on this machine, for Settings.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Availability {
    pub available: bool,
    pub device: Option<String>,
    pub reason: Option<String>,
}

static AVAILABILITY: tokio::sync::OnceCell<Availability> = tokio::sync::OnceCell::const_new();

/// [`Availability`], decided once per process: the runtime, the build and
/// the GPUs do not change while the app runs.
pub async fn availability() -> Availability {
    AVAILABILITY
        .get_or_init(|| async {
            let backend = super::WhisperCompiledBackend::current();
            if backend != super::WhisperCompiledBackend::Vulkan {
                return Availability {
                    available: false,
                    device: None,
                    reason: Some(format!("this build runs Whisper on {}", backend.as_str())),
                };
            }
            let decided = tokio::task::spawn_blocking(move || device_for(super::whisper_gpu(backend).as_ref()))
                .await
                .map_err(|error| anyhow!("{error}"))
                .and_then(|decided| decided);
            match decided {
                Ok(Some(device)) => Availability { available: true, device: Some(device), reason: None },
                Ok(None) => Availability {
                    available: false,
                    device: None,
                    reason: Some("the GPU Protocol uses is not an Intel GPU".to_string()),
                },
                Err(error) => Availability { available: false, device: None, reason: Some(format!("{error:#}")) },
            }
        })
        .await
        .clone()
}

/// A live call on `openvino` off the async runtime, with the
/// `(text, confidence, is_partial)` of `transcribe_audio_with_confidence`.
/// The confidence is that function's length-based estimate for one segment.
pub(crate) async fn live_call(
    openvino: std::sync::Arc<OpenVinoWhisper>,
    samples: Vec<f32>,
    language: Option<String>,
    initial_prompt: Option<&str>,
) -> Result<(String, f32, bool)> {
    let prompt = initial_prompt.map(str::to_string);
    let is_partial = samples.len() < 15 * 16_000;
    let text = tokio::task::spawn_blocking(move || openvino.live_text(&samples, language.as_deref(), prompt.as_deref()))
        .await
        .map_err(|error| anyhow!("the OpenVINO call task failed: {error}"))??;
    let confidence = if text.is_empty() { 0.0 } else { (text.len() as f32 / 100.0).min(0.9) + 0.1 };
    Ok((text, confidence, is_partial))
}

/// A post-meeting piece on `openvino` off the async runtime
/// ([`OpenVinoWhisper::piece_segments`]).
pub(crate) async fn piece_call(
    openvino: std::sync::Arc<OpenVinoWhisper>,
    samples: &[f32],
    language: Option<&str>,
    initial_prompt: Option<&str>,
) -> Result<Vec<TimedText>> {
    let samples = samples.to_vec();
    let language = language.map(str::to_string);
    let prompt = initial_prompt.map(str::to_string);
    tokio::task::spawn_blocking(move || openvino.piece_segments(&samples, language.as_deref(), prompt.as_deref()))
        .await
        .map_err(|error| anyhow!("the OpenVINO call task failed: {error}"))?
}

impl WhisperEngine {
    /// Loads `model_name`'s OpenVINO companion (`model_catalog::openvino`)
    /// when one is installed and the device rule picks an OpenVINO GPU; true
    /// when it did, and whisper.cpp is then not loaded. A failure is logged and
    /// shown in Settings, and the model loads on whisper.cpp.
    pub(crate) async fn load_openvino_companion(&self, model_name: &str) -> bool {
        record(BackendStatus::default());
        let Some(dir) = crate::model_catalog::openvino::installed_companion(model_name) else {
            return false;
        };
        if !is_model_dir(&dir) {
            log::warn!("The OpenVINO companion of {model_name} at {} lacks model files; using whisper.cpp", dir.display());
            return false;
        }
        let taken = self.try_openvino(&dir).await;
        if taken {
            log::info!("Successfully loaded model: {model_name} on OpenVINO ({})", dir.display());
        }
        taken
    }

    /// The loaded OpenVINO pipeline, if the model runs on OpenVINO.
    pub(crate) fn loaded_openvino(&self) -> Option<std::sync::Arc<OpenVinoWhisper>> {
        self.openvino.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    pub(crate) fn set_openvino(&self, loaded: Option<OpenVinoWhisper>) -> bool {
        let mut slot = self.openvino.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        let had = slot.is_some();
        *slot = loaded.map(std::sync::Arc::new);
        had
    }

    /// Loads `model_dir` (an OpenVINO model) on the OpenVINO device the rule
    /// picks for this build's GPU. `Ok(None)` when the rule picks none: a
    /// non-Vulkan build, or a GPU that is not an Intel GPU OpenVINO lists.
    /// An error is a runtime, device or compile failure, which the caller
    /// reports and falls back from.
    pub(crate) async fn load_openvino(&self, model_dir: &Path) -> Result<Option<String>> {
        let backend = super::WhisperCompiledBackend::current();
        if backend != super::WhisperCompiledBackend::Vulkan {
            return Ok(None);
        }
        let model_dir = model_dir.to_path_buf();
        let loaded = tokio::task::spawn_blocking(move || -> Result<Option<OpenVinoWhisper>> {
            let Some(device) = device_for(super::whisper_gpu(backend).as_ref())? else {
                return Ok(None);
            };
            OpenVinoWhisper::load(&model_dir, &device).map(Some)
        })
        .await
        .map_err(|error| anyhow!("the OpenVINO load task failed: {error}"))??;
        let device = loaded.as_ref().map(|loaded| loaded.device().to_string());
        self.set_openvino(loaded);
        Ok(device)
    }

    /// [`Self::load_openvino`] for a model load that can fall back to
    /// whisper.cpp: records the outcome for Settings, logs a failure as an
    /// error, and says whether OpenVINO took the model.
    pub(crate) async fn try_openvino(&self, model_dir: &Path) -> bool {
        match self.load_openvino(model_dir).await {
            Ok(Some(device)) => {
                record(BackendStatus { openvino_device: Some(device), fallback_reason: None });
                true
            }
            Ok(None) => false,
            Err(error) => {
                log::error!("OpenVINO could not take over Whisper; falling back to whisper.cpp on Vulkan: {error:#}");
                record(BackendStatus { openvino_device: None, fallback_reason: Some(format!("{error:#}")) });
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_piece_that_ends_in_the_vads_pause_is_heard_to_the_last_speech_and_the_pad() {
        // 5 s, the last 2 s silent: what the batch VAD hands over when speech
        // ended 2 s (its redemption time) before the piece did.
        let samples = vec![0.0f32; 5 * 16_000];
        assert_eq!(speech_end(&samples), 3 * 16_000 + SPEECH_END_PAD_MS * 16);
    }

    #[test]
    fn a_piece_too_short_to_hold_the_pause_is_heard_whole() {
        let samples = vec![0.0f32; 3 * 16_000];
        assert_eq!(speech_end(&samples), samples.len());
    }

    #[test]
    fn model_folders_need_every_file_genai_reads() {
        let folder = tempfile::tempdir().unwrap();
        for file in &MODEL_FILES[1..] {
            std::fs::write(folder.path().join(file), b"x").unwrap();
        }
        assert!(!is_model_dir(folder.path()));
        std::fs::write(folder.path().join(MODEL_FILES[0]), b"x").unwrap();
        assert!(is_model_dir(folder.path()));
    }
}
