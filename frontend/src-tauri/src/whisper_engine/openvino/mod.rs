//! Whisper on OpenVINO GenAI, for the Intel GPU whisper.cpp would otherwise run
//! on through Vulkan (#79). On an Arc B390, with the kit on `fleurs-ru`, GenAI's
//! `WhisperPipeline` ran Large V3 Turbo about four times faster than
//! whisper.cpp 1.8.3 on Vulkan, live and after meetings, for about a quarter
//! of the package energy, at the same word error rate.
//!
//! - The runtime ([`genai`]) is downloaded on each PC from Intel's archive,
//!   as the catalog pins it (`model_catalog::runtime`), into the app's data.
//!   It is loaded on first use and stays loaded for the process, like ONNX
//!   Runtime; the app starts, and whisper.cpp runs, without it.
//! - [`device`] decides whether the GPU whisper.cpp would pick is an Intel GPU
//!   that OpenVINO can take over.
//! - [`OpenVinoWhisper`] owns one pipeline (an encoder and a stateful decoder
//!   compiled for that GPU). `WhisperEngine` holds it in place of a whisper.cpp
//!   context and drops it on unload, on a model switch and at exit.

pub mod device;
pub mod genai;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

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

/// The runtime version this process loaded, or tried to: its folder, version
/// and the outcome. Set once. A process never loads a second version: both
/// versions' libraries have the same names, and Windows resolves a
/// dependency by name to the one already loaded, so the two would mix.
struct LoadedRuntime {
    dir: PathBuf,
    version: String,
    outcome: std::result::Result<&'static GenAi, String>,
}

static RUNTIME: Mutex<Option<LoadedRuntime>> = Mutex::new(None);

fn loaded() -> std::sync::MutexGuard<'static, Option<LoadedRuntime>> {
    RUNTIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The installed runtime version to load (`model_catalog::openvino`). The
/// kit's tests may name an installed version's folder in
/// `MEASURE_OPENVINO_RUNTIME` instead.
fn runtime_to_load() -> std::result::Result<crate::model_catalog::runtime::Installed, String> {
    #[cfg(test)]
    if let Some(dir) = std::env::var_os("MEASURE_OPENVINO_RUNTIME").map(PathBuf::from) {
        let record = crate::model_catalog::runtime::verified(&dir)
            .ok_or_else(|| format!("{} is not an installed, verified OpenVINO runtime", dir.display()))?;
        return Ok(crate::model_catalog::runtime::Installed { dir, record });
    }
    crate::model_catalog::openvino::runtime_to_load()
}

/// The process's runtime, loaded on first use from the version installed in
/// the app's data. A runtime that is not installed, or that a crash stopped
/// ([`stopped`]), is looked for again on the next call (it can be installed,
/// or retried, while the app runs); a load, failed or not, is kept for the
/// process.
pub fn runtime() -> Result<&'static GenAi> {
    let mut slot = loaded();
    if let Some(loaded) = slot.as_ref() {
        return loaded.outcome.clone().map_err(|error| anyhow!("{error}"));
    }
    let chosen = runtime_to_load().map_err(|reason| anyhow!("{reason}"))?;
    let outcome = guarded(Step::Load, || GenAi::load(&chosen.dir))
        .map_err(|stopped| anyhow!("{stopped}"))?
        .map(|api| &*Box::leak(Box::new(api)))
        .map_err(|error| format!("OpenVINO GenAI {} could not be loaded: {error}", chosen.record.version));
    match &outcome {
        Ok(_) => log::info!("Loaded OpenVINO GenAI {} from {}", chosen.record.version, chosen.dir.display()),
        Err(error) => log::error!("{error}"),
    }
    *slot = Some(LoadedRuntime { dir: chosen.dir, version: chosen.record.version, outcome: outcome.clone() });
    outcome.map_err(|error| anyhow!("{error}"))
}

/// The folder of the runtime version this process loaded or tried to load:
/// it cannot be deleted while the process runs.
pub fn loaded_runtime_dir() -> Option<PathBuf> {
    loaded().as_ref().map(|loaded| loaded.dir.clone())
}

/// Runs `work` with that folder while no load can start, so a prune of the
/// runtime's versions never deletes one as it is being loaded.
pub fn with_runtime_slot<T>(work: impl FnOnce(Option<&Path>) -> T) -> T {
    let slot = loaded();
    work(slot.as_ref().map(|loaded| loaded.dir.as_path()))
}

/// Native work of OpenVINO's that can take the process down with it: a
/// broken driver or runtime crashes inside these calls, where no `Result`
/// reaches the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Load,
    ListGpus,
    Compile,
}

impl Step {
    fn describe(self) -> &'static str {
        match self {
            Step::Load => "loading its libraries",
            Step::ListGpus => "looking for the GPU",
            Step::Compile => "preparing the model for the GPU",
        }
    }
}

/// The crash guard around those steps: the marker names the steps running
/// and is removed when none runs. A marker found by the first step of a
/// process was left by a process that died in those steps, and OpenVINO then
/// stays off, saying so in Settings, until the person retries ([`retry`]);
/// otherwise the app would crash again at each start. A process that ends on
/// purpose while a step runs removes it first ([`set_closing`]).
struct Guard {
    marker: Option<PathBuf>,
    checked: bool,
    stopped: Option<String>,
    /// One entry per step running now, in the order they started.
    running: Vec<Step>,
    closing: bool,
}

impl Guard {
    const fn new(marker: Option<PathBuf>) -> Mutex<Guard> {
        Mutex::new(Guard { marker, checked: false, stopped: None, running: Vec::new(), closing: false })
    }

    /// Beside the runtime's versions, outside the folder prunes empty.
    fn marker(&self) -> PathBuf {
        self.marker
            .clone()
            .unwrap_or_else(|| crate::paths::install_data_root().join("runtimes").join("openvino-genai.attempt"))
    }

    /// Reads the marker once per process, before this process writes one.
    fn check(&mut self) {
        if self.checked {
            return;
        }
        self.checked = true;
        if let Ok(marker) = std::fs::read_to_string(self.marker()) {
            let steps: Vec<&str> = marker.lines().map(str::trim).filter(|step| !step.is_empty()).collect();
            let steps = if steps.is_empty() { "running".to_string() } else { steps.join(" and ") };
            let message = format!(
                "Protocol closed unexpectedly the last time OpenVINO was {steps}, so Whisper runs on Vulkan. Try OpenVINO again in Settings › Transcription."
            );
            log::error!("{message}");
            self.stopped = Some(message);
        }
    }

    /// Writes the steps running now into the marker, one per line, or
    /// removes it when none runs or the process is closing.
    fn record(&self) {
        let marker = self.marker();
        if self.running.is_empty() || self.closing {
            let _ = std::fs::remove_file(&marker);
            return;
        }
        let mut steps: Vec<&str> = Vec::new();
        for step in &self.running {
            if !steps.contains(&step.describe()) {
                steps.push(step.describe());
            }
        }
        let written = marker.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&marker, steps.join("\n")));
        if let Err(error) = written {
            log::warn!("Cannot write the OpenVINO crash marker {}: {error}", marker.display());
        }
    }
}

static GUARD: Mutex<Guard> = Guard::new(None);

fn lock_guard(guard: &Mutex<Guard>) -> std::sync::MutexGuard<'_, Guard> {
    guard.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Why OpenVINO is off after a crash, if it is.
pub fn stopped() -> Option<String> {
    stopped_in(&GUARD)
}

fn stopped_in(guard: &Mutex<Guard>) -> Option<String> {
    let mut guard = lock_guard(guard);
    guard.check();
    guard.stopped.clone()
}

/// Lets OpenVINO run again after a crash stopped it.
pub fn retry() {
    retry_in(&GUARD);
    DEVICE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
}

fn retry_in(guard: &Mutex<Guard>) {
    let mut guard = lock_guard(guard);
    guard.checked = true;
    guard.stopped = None;
    guard.record();
}

/// The process is ending on purpose (`RunEvent::Exit`, or the updater
/// closing the app to install): a step it cuts short did not crash, so the
/// marker goes and no step writes one from here on. `false` when the update
/// did not install and the app carries on.
pub fn set_closing(closing: bool) {
    set_closing_in(&GUARD, closing);
}

fn set_closing_in(guard: &Mutex<Guard>, closing: bool) {
    let mut guard = lock_guard(guard);
    guard.closing = closing;
    guard.record();
}

/// Runs `work` inside the crash guard; `Err` when a crash stopped OpenVINO.
fn guarded<T>(step: Step, work: impl FnOnce() -> T) -> std::result::Result<T, String> {
    guarded_in(&GUARD, step, work)
}

fn guarded_in<T>(guard: &Mutex<Guard>, step: Step, work: impl FnOnce() -> T) -> std::result::Result<T, String> {
    {
        let mut state = lock_guard(guard);
        state.check();
        if let Some(stopped) = &state.stopped {
            return Err(stopped.clone());
        }
        state.running.push(step);
        state.record();
    }
    /// Ends the step also when `work` panics.
    struct Running<'a>(&'a Mutex<Guard>, Step);
    impl Drop for Running<'_> {
        fn drop(&mut self) {
            let mut state = lock_guard(self.0);
            if let Some(index) = state.running.iter().position(|step| *step == self.1) {
                state.running.remove(index);
            }
            state.record();
        }
    }
    let _running = Running(guard, step);
    Ok(work())
}

fn loaded_runtime_version() -> Option<String> {
    loaded().as_ref().map(|loaded| loaded.version.clone())
}

/// The OpenVINO device that takes over the GPU whisper.cpp would use, if any:
/// the rule in [`device`]. `chosen` is that GPU as ggml reports it
/// (`acceleration::whisper_gpu`). Logs which way it matched, or why not.
pub fn device_for(chosen: Option<&super::WhisperGpu>) -> Result<Option<String>> {
    let api = runtime()?;
    let gpus: Vec<device::OpenVinoGpu> = guarded(Step::ListGpus, || api.gpus())
        .map_err(|stopped| anyhow!("{stopped}"))??
        .into_iter()
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

/// Where compiled models are cached: OpenVINO's `CACHE_DIR` is a folder of
/// this, one per runtime version and model commit ([`cache_key`]). The first
/// load of a model compiles its kernels for the GPU (about 3–7 s for Large
/// V3 Turbo on an Arc B390, 835 MB of cache); later loads read them back in
/// under 1 s.
pub fn cache_root() -> PathBuf {
    crate::paths::install_data_root().join("cache").join("openvino")
}

/// The cache folder's name for a runtime version and a model commit. A blob
/// compiled by one runtime is not for another (OpenVINO names blobs by a hash
/// of the model and its compile options, not of its own build), and a model
/// update brings new weights: both start a cache of their own, and
/// [`prune_cache`] removes the ones nothing installed uses.
pub fn cache_key(runtime_version: &str, model_commit: &str) -> String {
    let commit: String = model_commit.chars().take(12).collect();
    format!("{runtime_version}_{commit}")
}

/// Removes everything in `root` but the folders named in `keep`. Best
/// effort: a blob a running pipeline holds open stays until the next prune.
fn prune_cache(root: &Path, keep: &[String]) {
    let Ok(read) = std::fs::read_dir(root) else { return };
    for item in read.flatten() {
        if keep.iter().any(|name| item.file_name() == name.as_str()) {
            continue;
        }
        let path = item.path();
        let removed = if item.file_type().is_ok_and(|kind| kind.is_dir()) {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        match removed {
            Ok(()) => log::info!("Removed the stale OpenVINO cache {}", path.display()),
            Err(error) => log::warn!("Cannot remove the stale OpenVINO cache {}: {error}", path.display()),
        }
    }
}

/// Removes the whole cache: Settings removed the last companion.
pub fn remove_cache() {
    let root = cache_root();
    prune_cache(&root, &[]);
    let _ = std::fs::remove_dir(&root);
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
    /// The model's commit, the second half of its cache key.
    model_commit: String,
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
    pub fn load(model_dir: &Path, model_commit: &str, device: &str) -> Result<Self> {
        let pipeline = Self::compile(model_dir, model_commit, device)?;
        Ok(Self {
            model_dir: model_dir.to_path_buf(),
            model_commit: model_commit.to_string(),
            device: device.to_string(),
            pipeline: Mutex::new(Some(pipeline)),
        })
    }

    fn compile(model_dir: &Path, model_commit: &str, device: &str) -> Result<Pipeline<'static>> {
        let _busy = busy::hold(BusyReason::ModelCompile);
        let api = runtime()?;
        let version = loaded_runtime_version().unwrap_or_default();
        // The caches of other runtime versions and of models no longer
        // installed go; this model's and the other installed companions' stay.
        let root = cache_root();
        let mut keep: Vec<String> = crate::model_catalog::openvino::installed_commits()
            .iter()
            .map(|commit| cache_key(&version, commit))
            .collect();
        keep.push(cache_key(&version, model_commit));
        prune_cache(&root, &keep);
        let cache = root.join(cache_key(&version, model_commit));
        if let Err(error) = std::fs::create_dir_all(&cache) {
            log::warn!("Cannot create the OpenVINO cache folder {}: {error}; compiling without a cache", cache.display());
        }
        let started = std::time::Instant::now();
        let pipeline = guarded(Step::Compile, || Pipeline::create(api, model_dir, device, cache.is_dir().then_some(cache.as_path())))
            .map_err(|stopped| anyhow!("{stopped}"))?
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
            *slot = Some(Self::compile(&self.model_dir, &self.model_commit, &self.device)?);
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
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    /// Offer the download here: the Vulkan build, and the GPU whisper.cpp
    /// uses is an Intel GPU ([`device::offer_for`]).
    pub offer: bool,
    /// That GPU, as Vulkan names it.
    pub gpu: Option<String>,
    /// Why the download is not offered.
    pub reason: Option<String>,
    /// With the runtime installed: the OpenVINO device the rule picks…
    pub device: Option<String>,
    /// …or why OpenVINO cannot take Whisper here after all: OpenVINO lists
    /// no GPU that is whisper.cpp's, or the runtime does not load.
    pub mismatch: Option<String>,
}

/// The offer half of [`Availability`], decided once per process: the build
/// and the GPUs do not change while the app runs.
static OFFER: tokio::sync::OnceCell<Availability> = tokio::sync::OnceCell::const_new();

/// The device half, decided once a runtime is loaded: a process never loads
/// another one.
static DEVICE: Mutex<Option<std::result::Result<Option<String>, String>>> = Mutex::new(None);

async fn offer() -> Availability {
    OFFER
        .get_or_init(|| async {
            let backend = super::WhisperCompiledBackend::current();
            if backend != super::WhisperCompiledBackend::Vulkan {
                return Availability { reason: Some(format!("this build runs Whisper on {}", backend.as_str())), ..Default::default() };
            }
            let decided = tokio::task::spawn_blocking(move || {
                let gpu = super::whisper_gpu(backend);
                let chosen = gpu.as_ref().map(|gpu| device::ChosenGpu {
                    pci_bus_id: gpu.pci_bus_id.as_deref(),
                    name: &gpu.name,
                    integrated: gpu.integrated,
                });
                (device::offer_for(chosen, &device::display_adapters()), gpu.map(|gpu| gpu.name))
            })
            .await;
            match decided {
                Ok((true, gpu)) => Availability { offer: true, gpu, ..Default::default() },
                Ok((false, Some(gpu))) => Availability {
                    reason: Some(format!("Whisper runs on {gpu}, which is not an Intel GPU")),
                    gpu: Some(gpu),
                    ..Default::default()
                },
                Ok((false, None)) => Availability { reason: Some("Whisper runs on no GPU here".to_string()), ..Default::default() },
                Err(error) => Availability { reason: Some(format!("the GPU check failed: {error}")), ..Default::default() },
            }
        })
        .await
        .clone()
}

/// [`Availability`]: whether to offer the download, from what the app knows
/// without OpenVINO, and once the runtime is installed, the device the rule
/// picks or why there is none, which Settings shows instead of staying
/// silent.
pub async fn availability() -> Availability {
    let mut availability = offer().await;
    // After a crash the row says so itself (`stopped`), with a retry.
    if !availability.offer || stopped().is_some() || (loaded_runtime_dir().is_none() && runtime_to_load().is_err()) {
        return availability;
    }
    let cached = DEVICE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let decided = match cached {
        Some(decided) => decided,
        None => {
            let backend = super::WhisperCompiledBackend::current();
            let decided = tokio::task::spawn_blocking(move || device_for(super::whisper_gpu(backend).as_ref()))
                .await
                .map_err(|error| anyhow!("{error}"))
                .and_then(|decided| decided)
                .map_err(|error| format!("{error:#}"));
            if loaded_runtime_dir().is_some() {
                *DEVICE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(decided.clone());
            }
            decided
        }
    };
    let gpu = availability.gpu.clone().unwrap_or_else(|| "the GPU Whisper uses".to_string());
    match decided {
        Ok(Some(device)) => availability.device = Some(device),
        Ok(None) => {
            availability.mismatch = Some(format!("OpenVINO lists no Intel GPU that is {gpu}, so Whisper stays on Vulkan"))
        }
        Err(error) => availability.mismatch = Some(error),
    }
    availability
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
        let Some(companion) = crate::model_catalog::openvino::installed_companion(model_name) else {
            return false;
        };
        if !is_model_dir(&companion.dir) {
            log::warn!("The OpenVINO companion of {model_name} at {} lacks model files; using whisper.cpp", companion.dir.display());
            return false;
        }
        let taken = self.try_openvino(&companion.dir, &companion.commit).await;
        if taken {
            log::info!("Successfully loaded model: {model_name} on OpenVINO ({})", companion.dir.display());
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

    /// Loads `model_dir` (an OpenVINO model at `model_commit`) on the
    /// OpenVINO device the rule picks for this build's GPU. `Ok(None)` when
    /// the rule picks none: a non-Vulkan build, or a GPU that is not an Intel
    /// GPU OpenVINO lists. An error is a runtime, device or compile failure
    /// (a runtime that is not installed or that this build cannot run among
    /// them), which the caller reports and falls back from.
    pub(crate) async fn load_openvino(&self, model_dir: &Path, model_commit: &str) -> Result<Option<String>> {
        let backend = super::WhisperCompiledBackend::current();
        if backend != super::WhisperCompiledBackend::Vulkan {
            return Ok(None);
        }
        let model_dir = model_dir.to_path_buf();
        let model_commit = model_commit.to_string();
        let loaded = tokio::task::spawn_blocking(move || -> Result<Option<OpenVinoWhisper>> {
            let Some(device) = device_for(super::whisper_gpu(backend).as_ref())? else {
                return Ok(None);
            };
            OpenVinoWhisper::load(&model_dir, &model_commit, &device).map(Some)
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
    pub(crate) async fn try_openvino(&self, model_dir: &Path, model_commit: &str) -> bool {
        match self.load_openvino(model_dir, model_commit).await {
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
    fn the_cache_keeps_one_folder_per_runtime_version_and_model_commit_in_use() {
        let root = tempfile::tempdir().unwrap();
        let commit = "b568445dd5dc8c695bde596f8acbb4694fd6ba64";
        let current = cache_key("2026.5.0.0", commit);
        assert_eq!(current, "2026.5.0.0_b568445dd5dc");
        for stale in [cache_key("2026.4.1.0", commit), cache_key("2026.5.0.0", "0123456789abcdef")] {
            std::fs::create_dir_all(root.path().join(stale).join("blob")).unwrap();
        }
        std::fs::create_dir_all(root.path().join(&current)).unwrap();
        // Blobs the round-1 builds wrote straight into the cache folder.
        std::fs::write(root.path().join("123456.blob"), b"x").unwrap();
        prune_cache(root.path(), &[current.clone()]);
        let left: Vec<String> = std::fs::read_dir(root.path())
            .unwrap()
            .flatten()
            .map(|item| item.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, [current]);
    }

    #[test]
    fn a_crash_inside_a_guarded_step_keeps_openvino_off_at_the_next_start_until_a_retry() {
        let data = tempfile::tempdir().unwrap();
        let marker = data.path().join("runtimes").join("openvino-genai.attempt");

        // The marker names every step running; a step that ends leaves no
        // marker, also when nested in another.
        let running = Guard::new(Some(marker.clone()));
        let read = || std::fs::read_to_string(&marker).unwrap();
        let (inner, outer) = guarded_in(&running, Step::Load, || {
            let inner = guarded_in(&running, Step::ListGpus, read).unwrap();
            (inner, read())
        })
        .unwrap();
        assert_eq!(inner, "loading its libraries\nlooking for the GPU");
        assert_eq!(outer, "loading its libraries");
        assert!(!marker.exists());
        assert_eq!(stopped_in(&running), None);
        // A panic inside a step ends it too.
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| guarded_in::<()>(&running, Step::Compile, || panic!("boom"))));
        assert!(panicked.is_err());
        assert!(!marker.exists());

        // A process died while listing GPUs and compiling: its marker stays
        // for the next one, which does not run OpenVINO and says why.
        std::fs::write(&marker, "looking for the GPU\npreparing the model for the GPU").unwrap();
        let next = Guard::new(Some(marker.clone()));
        let refused = guarded_in::<()>(&next, Step::Load, || panic!("OpenVINO ran after a crash")).unwrap_err();
        assert!(
            refused.contains("was looking for the GPU and preparing the model for the GPU,") && refused.contains("Try OpenVINO again"),
            "{refused}"
        );
        assert_eq!(stopped_in(&next).as_deref(), Some(refused.as_str()));
        assert!(marker.exists());

        // A retry runs it again.
        retry_in(&next);
        assert!(!marker.exists());
        assert_eq!(stopped_in(&next), None);
        assert_eq!(guarded_in(&next, Step::Load, || 7), Ok(7));
    }

    /// Quitting from the tray, or the updater closing the app, while a
    /// model compiles ends the process inside the step: no crash.
    #[test]
    fn quitting_during_a_guarded_step_is_not_taken_for_a_crash() {
        let data = tempfile::tempdir().unwrap();
        let marker = data.path().join("runtimes").join("openvino-genai.attempt");
        let app = Guard::new(Some(marker.clone()));
        guarded_in(&app, Step::Compile, || {
            assert!(marker.exists());
            set_closing_in(&app, true);
            assert!(!marker.exists());
            // A step that starts while the app closes writes no marker.
            guarded_in(&app, Step::Load, || assert!(!marker.exists())).unwrap();
            // The process ends here; the next one runs OpenVINO.
            let next = Guard::new(Some(marker.clone()));
            assert_eq!(stopped_in(&next), None);
        })
        .unwrap();

        // An update that did not install: the app carries on, guarded again.
        set_closing_in(&app, false);
        guarded_in(&app, Step::Compile, || assert!(marker.exists())).unwrap();
        assert!(!marker.exists());
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
