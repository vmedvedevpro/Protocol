//! The Speech check's four steps (#233). Each runs one engine on the sample
//! the way the app runs it, on engines of its own: the recording's engines
//! (`WHISPER_ENGINE`, `PARAKEET_ENGINE`) are never touched here.
//!
//! "Picked" comes from each engine's own device rule, the function its load
//! calls too (`parakeet_engine::planned_encoder`;
//! `openvino::openvino_model_for` and `openvino::planned_openvino_device`,
//! else whisper.cpp's `context_parameters`; `nemotron::planned_provider`);
//! "ran on" from the loaded engine afterwards. When their kinds differ, the
//! step reports the fallback with the error the engine recorded. One
//! fallback stays out of sight: whisper.cpp's own move to the processor
//! inside a Vulkan context, which the engine does not report
//! (docs/SPEECH_CHECK.md, Limits).

use std::time::Instant;

use crate::audio::pipeline::{live_redemption_ms, LIVE_NEGATIVE_SPEECH_THRESHOLD, LIVE_POSITIVE_SPEECH_THRESHOLD};
use crate::audio::post_meeting::{self, Pass, PieceOutcome};
use crate::audio::vad::{DEFAULT_NEGATIVE_SPEECH_THRESHOLD, DEFAULT_POSITIVE_SPEECH_THRESHOLD};
use crate::diarization::nemotron;
use crate::parakeet_engine::chunking::{self, Live};
use crate::parakeet_engine::{Encoder, ParakeetEngine};
use crate::whisper_engine::WhisperEngine;

use super::report::{ClipResult, Device, DeviceKind, Fallback, ModelId, StepKind, StepReport, StepStatus};
use super::sample::Clip;
use super::score;

/// What every step gets.
pub struct Context<'a> {
    pub clips: &'a [Clip],
    pub cancelled: &'a (dyn Fn() -> bool + Sync),
}

impl Context<'_> {
    pub fn is_cancelled(&self) -> bool {
        (self.cancelled)()
    }
}

fn ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// A transcript's pieces as one text.
fn joined(texts: &[String]) -> String {
    texts.iter().map(|text| text.trim()).filter(|text| !text.is_empty()).collect::<Vec<_>>().join(" ")
}

/// Passed when every clip passed; the first failing clip's reason otherwise.
fn finish(mut step: StepReport) -> StepReport {
    if let Some(clip) = step.clips.iter().find(|clip| !clip.passed) {
        let reason = match (clip.word_error_rate, clip.speakers) {
            (Some(rate), _) => format!(
                "The {} clip came out with {:.0}% of its words wrong (at most {:.0}% pass)",
                clip.clip,
                rate * 100.0,
                score::MAX_WORD_ERROR_RATE * 100.0
            ),
            (_, Some(speakers)) => format!(
                "The {} clip gave {:.0}% of the speech it labelled to the right voice and labelled {:.0}% of the turns (at least {:.0}% and {:.0}% pass)",
                clip.clip,
                speakers.share * 100.0,
                speakers.coverage * 100.0,
                score::MIN_SPEAKER_SHARE * 100.0,
                score::MIN_SPEAKER_COVERAGE * 100.0
            ),
            _ => format!("The {} clip failed", clip.clip),
        };
        return step.failed(reason);
    }
    step.status = StepStatus::Passed;
    step
}

/// The installed copy's catalog commit, from its install record.
fn version_of(record: &std::path::Path) -> Option<String> {
    crate::model_catalog::installed::read_record(record).map(|record| record.commit.chars().take(12).collect())
}

/// The start the two speech steps share: the step with its model, picked
/// device and the inputs of the pick; then [`load_timed`], which ends the
/// step when a Cancel came or the load failed.
fn speech_step(kind: StepKind, model: &str, picked: Device, because: String, inputs: Vec<(String, String)>) -> StepReport {
    let mut step = StepReport::new(kind, StepStatus::Failed);
    step.model = Some(ModelId { id: model.into(), version: None });
    step.picked = Some(picked);
    step.picked_because = Some(because);
    step.inputs = inputs;
    step
}

async fn load_timed(mut step: StepReport, context: &Context<'_>, load: impl std::future::Future<Output = anyhow::Result<()>>) -> Result<StepReport, StepReport> {
    if context.is_cancelled() {
        return Err(step.stopped());
    }
    let started = Instant::now();
    if let Err(error) = load.await {
        let engine = if step.kind == StepKind::Parakeet { "Parakeet" } else { "Whisper" };
        return Err(step.failed(format!("{engine} did not load: {error}")));
    }
    step.load_ms = Some(ms(started));
    Ok(step)
}

// --- Parakeet --------------------------------------------------------------

/// The Intel NPU's reason for not running, as its state records it.
fn npu_reason() -> String {
    #[cfg(windows)]
    if let Some(reason) = crate::parakeet_engine::npu::state::status().reason {
        return reason;
    }
    "the NPU did not start".into()
}

/// The Intel NPU and its state, as `planned_encoder` reads them (Windows).
fn npu_inputs() -> Vec<(String, String)> {
    #[cfg(windows)]
    {
        let npu = crate::parakeet_engine::npu::state::status();
        let state = if npu.present { format!("{:?}", npu.state).to_lowercase() } else { "none".into() };
        std::iter::once(("Intel NPU".to_string(), state)).chain(npu.reason.map(|reason| ("Intel NPU reason".to_string(), reason))).collect()
    }
    #[cfg(not(windows))]
    Vec::new()
}

/// The encoder's device as `planned_encoder` decides it, with why and the
/// inputs it read.
fn parakeet_picked(model: &str) -> (Device, String, Vec<(String, String)>) {
    let labs = ("Parakeet on the GPU (Labs)".to_string(), if crate::parakeet_engine::labs::enabled() { "on" } else { "off" }.to_string());
    let inputs = std::iter::once(labs).chain(npu_inputs()).collect();
    let (device, because) = match crate::parakeet_engine::planned_encoder(model) {
        Encoder::Npu => (Device::new(DeviceKind::IntelNpu, "Intel NPU"), "the NPU is prepared for Parakeet v3"),
        Encoder::DirectMl => (Device::new(DeviceKind::DirectMl, "GPU (DirectML adapter 0)"), "Parakeet on the GPU is on in Labs"),
        Encoder::Processor if cfg!(windows) => (Device::processor(), "the Intel NPU is not ready for this model, and Parakeet on the GPU is off"),
        Encoder::Processor => (Device::processor(), "Parakeet runs on the processor here"),
    };
    (device, because.into(), inputs)
}

/// The device the loaded encoder runs on: the NPU while it holds it, else
/// the pick (a DirectML session is built with `error_on_failure`, so a load
/// that succeeded has it).
async fn parakeet_ran_on(engine: &ParakeetEngine, picked: &Device) -> Device {
    match (engine.uses_npu().await, picked.kind) {
        (true, _) => Device::new(DeviceKind::IntelNpu, "Intel NPU"),
        (false, DeviceKind::DirectMl) => picked.clone(),
        (false, _) => Device::processor(),
    }
}

/// Parakeet through the live path: the pieces the live VAD cuts (its
/// thresholds, redemption time and cap, `audio::pipeline`) and the live
/// call with its windows (`chunking::Live`), as the live worker and the
/// measuring kit's `parakeet-live` setting run them. It records whether
/// Parakeet keeps up with a meeting.
pub async fn parakeet(model: &str, context: &Context<'_>) -> StepReport {
    let (picked, because, inputs) = parakeet_picked(model);
    let mut step = speech_step(StepKind::Parakeet, model, picked.clone(), because, inputs);
    let engine = match ParakeetEngine::new_with_models_dir(Some(crate::paths::models_dir())) {
        Ok(engine) => engine,
        Err(error) => return step.failed(format!("Parakeet did not start: {error}")),
    };
    match engine.discover_models().await {
        Ok(models) => match models.iter().find(|info| info.name == model) {
            Some(info) if matches!(info.status, crate::parakeet_engine::ModelStatus::Available) => {
                step.model = Some(ModelId { id: model.into(), version: version_of(&crate::model_catalog::installed::record_path_for_dir(&info.path)) })
            }
            Some(_) => return step.not_downloaded(),
            None => return step.failed(format!("Parakeet has no model {model}")),
        },
        Err(error) => return step.failed(format!("Parakeet's models could not be listed: {error}")),
    }
    let mut step = match load_timed(step, context, engine.load_model(model)).await {
        Ok(step) => step,
        Err(ended) => return ended,
    };
    let ran_on = parakeet_ran_on(&engine, &picked).await;
    if ran_on.kind != picked.kind {
        step.fallback = Some(Fallback { from: picked.clone(), to: ran_on.clone(), error: npu_reason() });
    }

    let real_time = crate::audio::recording_preferences::is_real_time_transcription();
    step.inputs.push(("Faster live text".into(), if real_time { "on" } else { "off" }.into()));
    let (mut total_audio, mut total_processing) = (0.0, 0.0);
    for clip in context.clips {
        if context.is_cancelled() {
            return step.stopped();
        }
        // The live pipeline's VAD: its thresholds and redemption time (Faster
        // live text's when it is on), capped as it caps a segment.
        let pieces = match crate::audio::vad::get_speech_chunks_with_cap_and_progress(
            &clip.samples,
            live_redemption_ms(real_time),
            LIVE_POSITIVE_SPEECH_THRESHOLD,
            LIVE_NEGATIVE_SPEECH_THRESHOLD,
            crate::audio::vad::ContinuousSpeechCap::Streaming,
            |_, _| !context.is_cancelled(),
        ) {
            Ok(pieces) => pieces,
            Err(error) => return step.failed(format!("The VAD failed on the {} clip: {error}", clip.id)),
        };
        let mut live = Live::default();
        let mut texts: Vec<String> = Vec::new();
        let started = Instant::now();
        for piece in &pieces {
            if context.is_cancelled() {
                return step.stopped();
            }
            if !live.continues(piece.start_timestamp_ms) {
                if let Some(held) = live.flush() {
                    texts.push(chunking::text(&held.words));
                }
            }
            match engine.transcribe_live(&mut live, piece.start_timestamp_ms, piece.samples.clone(), piece.capped, None).await {
                Ok(text) => {
                    // log-audit: the text of the bundled public sample (FLEURS), never a meeting's.
                    log::debug!(
                        "[speech check] Parakeet {}: piece {:.2}-{:.2} s{}: {text:?}",
                        clip.id,
                        piece.start_timestamp_ms / 1000.0,
                        piece.end_timestamp_ms / 1000.0,
                        if piece.capped { " (capped)" } else { "" }
                    );
                    texts.push(text)
                }
                Err(error) => return step.failed(format!("Parakeet failed on the {} clip: {error}", clip.id)),
            }
        }
        if let Some(held) = live.flush() {
            texts.push(chunking::text(&held.words));
        }
        let result = ClipResult::text(clip, ms(started), joined(&texts), None);
        total_audio += result.audio_ms;
        total_processing += result.processing_ms;
        step.clips.push(result);
    }
    // The NPU can fail during a call and leave the rest to the processor.
    let after = parakeet_ran_on(&engine, &picked).await;
    if after.kind != ran_on.kind && step.fallback.is_none() {
        step.fallback = Some(Fallback { from: ran_on.clone(), to: after.clone(), error: npu_reason() });
    }
    step.ran_on = Some(after);
    if total_audio > 0.0 {
        step.keeps_up = Some(score::keeps_up(total_processing / total_audio));
    }
    engine.unload_model().await;
    finish(step)
}

// --- Whisper ---------------------------------------------------------------

/// An OpenVINO device in the one form "picked" and "ran on" both use.
#[cfg(any(windows, target_os = "linux"))]
fn openvino_device(device: &str) -> Device {
    Device::new(DeviceKind::IntelGpu, format!("Intel GPU (OpenVINO {})", device.trim()))
}

/// Where whisper.cpp runs a context here, as `context_parameters` decides.
fn whisper_cpp_device() -> (Device, String) {
    use crate::whisper_engine::acceleration::{whisper_gpu, WhisperCompiledBackend};
    let (_, acceleration) = crate::whisper_engine::whisper_engine::context_parameters(crate::audio::HardwareProfile::detect());
    let backend = acceleration.compiled_backend;
    if acceleration.use_gpu {
        let name = whisper_gpu(backend).map(|gpu| gpu.name).unwrap_or_else(|| format!("device {}", acceleration.gpu_device));
        return whisper_cpp_gpu(backend, &name);
    }
    let because = match (backend, crate::whisper_engine::vulkan::stopped()) {
        (_, Some(stopped)) => stopped,
        (WhisperCompiledBackend::Cpu, None) => "this build of Protocol runs Whisper on the processor".into(),
        (_, None) => "ggml lists no GPU here".into(),
    };
    (Device::processor(), because)
}

/// The GPU a whisper.cpp context of `backend` runs on, `name` being the
/// device ggml reports or its number, with why.
fn whisper_cpp_gpu(backend: crate::whisper_engine::acceleration::WhisperCompiledBackend, name: &str) -> (Device, String) {
    use crate::whisper_engine::acceleration::WhisperCompiledBackend;
    match backend {
        WhisperCompiledBackend::Vulkan => (Device::new(DeviceKind::Vulkan, format!("GPU (Vulkan): {name}")), "the first discrete GPU ggml lists, else its first GPU".into()),
        WhisperCompiledBackend::Metal => (Device::new(DeviceKind::Metal, "Apple GPU (Metal)"), "the macOS build runs Whisper on Metal".into()),
        WhisperCompiledBackend::Cuda => (Device::new(DeviceKind::Cuda, format!("GPU (CUDA): {name}")), "this build runs Whisper on CUDA".into()),
        WhisperCompiledBackend::HipBlas => (Device::new(DeviceKind::Hip, format!("GPU (HIP): {name}")), "this build runs Whisper on HIP".into()),
        // A CPU build never puts a context on a GPU (`whisper_context_acceleration_for`).
        WhisperCompiledBackend::Cpu => (Device::processor(), "this build of Protocol runs Whisper on the processor".into()),
    }
}

/// The device the loaded engine runs on.
fn whisper_ran_on(_engine: &WhisperEngine) -> Device {
    #[cfg(any(windows, target_os = "linux"))]
    if let Some(loaded) = _engine.loaded_openvino() {
        return openvino_device(loaded.device());
    }
    whisper_cpp_device().0
}

/// Where `model` loads: the OpenVINO model `openvino_model_for` names, on
/// the device `planned_openvino_device` names, as the load asks them;
/// otherwise whisper.cpp where `context_parameters` puts it. With the inputs
/// the rules read, Settings' OpenVINO row among them.
async fn whisper_picked(_model: &str) -> (Device, String, Vec<(String, String)>) {
    let (cpp, cpp_because) = whisper_cpp_device();
    let mut inputs = vec![("Whisper build".to_string(), crate::whisper_engine::acceleration::WhisperCompiledBackend::current().as_str().to_string())];
    if let Some(stopped) = crate::whisper_engine::vulkan::stopped() {
        inputs.push(("Vulkan crash guard".into(), stopped));
    }
    inputs.push(("whisper.cpp would use".into(), format!("{} ({cpp_because})", cpp.name)));
    #[cfg(any(windows, target_os = "linux"))]
    {
        use crate::whisper_engine::openvino;
        let gpu_version = crate::speech_choice::gpu_version(_model);
        let openvino_model = openvino::openvino_model_for(_model);
        inputs.push(("Intel GPU version".into(), match (&gpu_version, &openvino_model) {
            (Some(_), Some(_)) => "chosen, installed".into(),
            (Some(_), None) => "chosen, not installed".into(),
            (None, Some(_)) => "installed for this model".into(),
            (None, None) => "none".into(),
        }));
        let availability = openvino::availability().await;
        inputs.push(("OpenVINO offered".into(), if availability.offer { "yes" } else { "no" }.into()));
        for (name, value) in [("OpenVINO GPU", &availability.gpu), ("OpenVINO device", &availability.device), ("OpenVINO mismatch", &availability.mismatch), ("OpenVINO not offered because", &availability.reason), ("Intel OpenCL driver", &availability.driver)] {
            if let Some(value) = value {
                inputs.push((name.into(), value.clone()));
            }
        }
        if let Some(stopped) = openvino::stopped() {
            inputs.push(("OpenVINO crash guard".into(), stopped));
        }
        if openvino_model.is_some() {
            let planned = tokio::task::spawn_blocking(openvino::planned_openvino_device).await.map_err(anyhow::Error::from).and_then(|planned| planned);
            let because = match planned {
                Ok(Some(device)) => return (openvino_device(&device), "the Intel GPU version is installed and OpenVINO runs on whisper.cpp's GPU".into(), inputs),
                Ok(None) => format!("the Intel GPU version cannot run: {}", availability.mismatch.clone().unwrap_or_else(|| "OpenVINO picks no device here".into())),
                Err(error) => format!("the Intel GPU version cannot run: {error:#}"),
            };
            return (cpp, because, inputs);
        }
    }
    (cpp, cpp_because, inputs)
}

/// Whether `model` is on this computer: the Intel GPU version's folder, or
/// a ggml file that verified. Intel GPU versions exist on Windows and Linux
/// only; on macOS their names are in no model list, so they read as missing.
fn whisper_installed(models: &[crate::whisper_engine::whisper_engine::ModelInfo], model: &str) -> bool {
    #[cfg(any(windows, target_os = "linux"))]
    if let Some(version) = crate::speech_choice::gpu_version(model) {
        return crate::speech_choice::installed(&version).is_some();
    }
    models.iter().any(|info| info.name == model && matches!(info.status, crate::whisper_engine::whisper_engine::ModelStatus::Available))
}

/// The installed file or folder `model` loads from, for its version.
fn whisper_record(models: &[crate::whisper_engine::whisper_engine::ModelInfo], model: &str) -> Option<std::path::PathBuf> {
    let info = models.iter().find(|info| info.name == model)?;
    Some(if info.path.is_dir() {
        crate::model_catalog::installed::record_path_for_dir(&info.path)
    } else {
        crate::model_catalog::installed::record_path_for_file(&info.path)
    })
}

/// Whisper as the post-meeting pass runs it (`post_meeting::Pass`: the batch
/// VAD from pause to pause, the language detected once, the silence filter),
/// but not through retranscription or the import: so
/// `speech_choice::after_post_meeting_pass` never runs, and a successful
/// Intel GPU pass here does not retire the Compressed copy.
pub async fn whisper(model: &str, context: &Context<'_>) -> StepReport {
    let (picked, because, inputs) = whisper_picked(model).await;
    let mut step = speech_step(StepKind::Whisper, model, picked.clone(), because, inputs);
    let engine = match WhisperEngine::new_with_models_dir(Some(crate::paths::models_dir())) {
        Ok(engine) => engine,
        Err(error) => return step.failed(format!("Whisper did not start: {error}")),
    };
    match engine.discover_models().await {
        Ok(models) if !whisper_installed(&models, model) => return step.not_downloaded(),
        Ok(models) => step.model = Some(ModelId { id: model.into(), version: whisper_record(&models, model).and_then(|record| version_of(&record)) }),
        Err(error) => return step.failed(format!("Whisper's models could not be listed: {error}")),
    }
    let mut step = match load_timed(step, context, engine.load_model(model)).await {
        Ok(step) => step,
        Err(ended) => return ended,
    };
    let ran_on = whisper_ran_on(&engine);
    if ran_on.kind != picked.kind {
        #[cfg(any(windows, target_os = "linux"))]
        let error = crate::whisper_engine::openvino::backend_status().and_then(|status| status.fallback_reason);
        #[cfg(not(any(windows, target_os = "linux")))]
        let error: Option<String> = None;
        step.fallback = Some(Fallback { from: picked.clone(), to: ran_on.clone(), error: error.unwrap_or_else(|| "no reason was recorded".into()) });
    }
    step.ran_on = Some(ran_on);

    const TRACK: &str = "mixed audio";
    for clip in context.clips {
        if context.is_cancelled() {
            return step.stopped();
        }
        let segments = match post_meeting::speech(
            &clip.samples,
            DEFAULT_POSITIVE_SPEECH_THRESHOLD,
            DEFAULT_NEGATIVE_SPEECH_THRESHOLD,
            post_meeting::vad_cap(false),
            |_, _| !context.is_cancelled(),
        ) {
            Ok(segments) => segments,
            Err(error) => return step.failed(format!("The VAD failed on the {} clip: {error}", clip.id)),
        };
        let pieces = post_meeting::pieces(segments.into_iter().map(|segment| (segment, TRACK)).collect());
        let started = Instant::now();
        let mut pass = Pass::new(None, Some(&engine), None, None).dropping_silence_hallucinations();
        pass.detect_languages(pieces.iter().map(|(segment, track)| (segment, *track)), || context.is_cancelled()).await;
        let mut texts = Vec::new();
        for (piece, track) in &pieces {
            if context.is_cancelled() {
                return step.stopped();
            }
            match pass.transcribe(piece, *track).await {
                Ok(PieceOutcome::Rows(rows)) => texts.extend(rows.into_iter().map(|(text, _, _)| text)),
                Ok(PieceOutcome::Skipped(_) | PieceOutcome::Dropped(_)) => {}
                Err(error) => return step.failed(format!("Whisper failed on the {} clip: {error}", clip.id)),
            }
        }
        step.clips.push(ClipResult::text(clip, ms(started), joined(&texts), pass.detected_language(TRACK).map(str::to_string)));
    }
    engine.unload_model().await;
    finish(step)
}

// --- Speakers --------------------------------------------------------------

/// A speaker engine on each clip, as an import diarizes a file: the whole
/// clip as one track (`diarize_file_with_engine`), with the saved settings.
async fn speakers(engine_name: &'static str, context: &Context<'_>, mut step: StepReport) -> StepReport {
    let title = step.kind.title();
    let folder = match tempfile::tempdir() {
        Ok(folder) => folder,
        Err(error) => return step.failed(format!("No folder for the sample: {error}")),
    };
    for clip in context.clips {
        if context.is_cancelled() {
            return step.stopped();
        }
        let wav = folder.path().join(format!("{}.wav", clip.id));
        if let Err(error) = crate::diarization::dsp::write_wav_f32(&wav, &clip.samples) {
            return step.failed(format!("The {} clip could not be written: {error:#}", clip.id));
        }
        let started = Instant::now();
        let result = tokio::task::spawn_blocking(move || crate::diarization::diarize_file_with_engine(&wav, engine_name, None, None)).await;
        let processing_ms = ms(started);
        let result = match result {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => return step.failed(format!("{title} failed on the {} clip: {error}", clip.id)),
            Err(error) => return step.failed(format!("{title} stopped on the {} clip: {error}", clip.id)),
        };
        let found: Vec<score::Turn> = result
            .segments
            .iter()
            .map(|segment| score::Turn { start_ms: segment.start as f64 * 1000.0, end_ms: segment.end as f64 * 1000.0, label: segment.speaker })
            .collect();
        log::debug!(
            "[speech check] {engine_name} {}: {}",
            clip.id,
            found.iter().map(|turn| format!("{:.2}-{:.2}={}", turn.start_ms / 1000.0, turn.end_ms / 1000.0, turn.label)).collect::<Vec<_>>().join(" ")
        );
        step.clips.push(ClipResult::speakers(clip, processing_ms, score::speaker_score(&clip.voices(), &found)));
    }
    finish(step)
}

/// Pyannote's segmentation and WeSpeaker's embeddings, which run on ONNX
/// Runtime's CPU provider on every platform (`diarization/models.rs`).
pub async fn pyannote(context: &Context<'_>) -> StepReport {
    if !crate::diarization::pyannote_models_available() {
        return StepReport::new(StepKind::Pyannote, StepStatus::NotChecked).with_reason("The speaker models are not in this copy of Protocol");
    }
    let mut step = StepReport::new(StepKind::Pyannote, StepStatus::Failed);
    step.model = Some(ModelId { id: "pyannote segmentation 3.0 + WeSpeaker ResNet34".into(), version: Some("bundled".into()) });
    step.picked = Some(Device::processor());
    step.picked_because = Some("Pyannote and WeSpeaker run on ONNX Runtime's CPU provider on every platform".into());
    step.ran_on = Some(Device::processor());
    speakers("pyannote", context, step).await
}

/// Nemotron where `nemotron::planned_provider` puts it, with a CPU session
/// after DirectML fails (`sortformer/support.rs`).
pub async fn nemotron(context: &Context<'_>) -> StepReport {
    if !crate::diarization::nemotron_models_available() {
        return StepReport::new(StepKind::Nemotron, StepStatus::NotChecked).with_reason("The model is not downloaded");
    }
    let mut step = StepReport::new(StepKind::Nemotron, StepStatus::Failed);
    step.model = Some(ModelId { id: nemotron::NEMOTRON_MODEL_FILENAME.into(), version: Some(nemotron::NEMOTRON_SHA256[..12].into()) });
    let directml = Device::new(DeviceKind::DirectMl, "GPU (DirectML adapter 0)");
    let (picked, because) = match nemotron::planned_provider() {
        nemotron::Provider::DirectMl => (directml.clone(), "Nemotron asks DirectML first on Windows"),
        nemotron::Provider::Cpu => (Device::processor(), "Nemotron runs on ONNX Runtime's CPU provider outside Windows"),
    };
    step.picked = Some(picked.clone());
    step.picked_because = Some(because.into());
    nemotron::forget_last_session();
    let mut step = speakers("nemotron", context, step).await;
    if let Some(session) = nemotron::last_session() {
        let (ran_on, error) = match session {
            nemotron::NemotronSession::DirectMl => (directml, None),
            nemotron::NemotronSession::Cpu { directml_error } => (Device::processor(), directml_error),
        };
        if ran_on.kind != picked.kind {
            step.fallback = Some(Fallback { from: picked, to: ran_on.clone(), error: error.unwrap_or_else(|| "no reason was recorded".into()) });
        }
        step.ran_on = Some(ran_on);
    }
    step
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_passes_only_when_every_clip_does() {
        let clip = |passed, rate| ClipResult {
            clip: "en".into(),
            audio_ms: 1000.0,
            processing_ms: 100.0,
            real_time_factor: 0.1,
            text: None,
            language: None,
            word_errors: None,
            word_error_rate: Some(rate),
            speakers: None,
            passed,
        };
        let mut step = StepReport::new(StepKind::Whisper, StepStatus::Failed);
        step.clips = vec![clip(true, 0.05), clip(true, 0.1)];
        assert_eq!(finish(step.clone()).status, StepStatus::Passed);
        step.clips.push(clip(false, 0.9));
        let failed = finish(step);
        assert_eq!(failed.status, StepStatus::Failed);
        assert_eq!(failed.reason.as_deref(), Some("The en clip came out with 90% of its words wrong (at most 50% pass)"));
    }

    #[test]
    fn whisper_cpp_is_named_by_the_backend_it_runs_on() {
        use crate::whisper_engine::acceleration::WhisperCompiledBackend as Backend;
        let kind = |backend| whisper_cpp_gpu(backend, "device 0").0.kind;
        assert_eq!(kind(Backend::Vulkan), DeviceKind::Vulkan);
        assert_eq!(kind(Backend::Metal), DeviceKind::Metal);
        assert_eq!(kind(Backend::Cuda), DeviceKind::Cuda);
        assert_eq!(kind(Backend::HipBlas), DeviceKind::Hip);
        assert_eq!(kind(Backend::Cpu), DeviceKind::Processor);
        assert_eq!(whisper_cpp_gpu(Backend::Cuda, "device 0").0.name, "GPU (CUDA): device 0");
    }

    #[test]
    fn pieces_join_without_their_blank_ones() {
        assert_eq!(joined(&[" one ".into(), String::new(), "two".into()]), "one two");
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn openvino_is_named_in_one_form_for_picked_and_ran_on() {
        assert_eq!(openvino_device("GPU"), Device::new(DeviceKind::IntelGpu, "Intel GPU (OpenVINO GPU)"));
        assert_eq!(openvino_device(" GPU.1 "), openvino_device("GPU.1"));
    }
}
