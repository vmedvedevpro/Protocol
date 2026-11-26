//! The Speech check's four steps (#233). Each runs one engine on the sample
//! the way the app runs it, on engines of its own: the recording's engines
//! (`WHISPER_ENGINE`, `PARAKEET_ENGINE`) are never touched here.
//!
//! "Picked" is read before the load from the inputs the engines' own device
//! rules read (the NPU's state, the Labs switch, OpenVINO's availability and
//! crash guard, ggml's GPU and the Vulkan guard); "ran on" is read from the
//! loaded engine afterwards. When they differ, the step reports the fallback
//! with the error the app recorded, as Settings does: the engines never
//! substitute a device silently, and neither does the check.

use std::time::Instant;

use crate::audio::pipeline::{live_redemption_ms, LIVE_NEGATIVE_SPEECH_THRESHOLD, LIVE_POSITIVE_SPEECH_THRESHOLD};
use crate::audio::post_meeting::{self, Pass, PieceOutcome};
use crate::audio::vad::{DEFAULT_NEGATIVE_SPEECH_THRESHOLD, DEFAULT_POSITIVE_SPEECH_THRESHOLD};
use crate::parakeet_engine::chunking::{self, Live};
use crate::parakeet_engine::ParakeetEngine;
use crate::whisper_engine::WhisperEngine;

use super::report::{ClipResult, Device, Fallback, ModelId, StepKind, StepReport, StepStatus};
use super::sample::Clip;
use super::score;

/// What every step gets.
pub struct Context<'a> {
    pub clips: &'a [Clip],
    pub cancelled: &'a (dyn Fn() -> bool + Sync),
}

const PROCESSOR: &str = "processor";

fn ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn cancelled_step(mut step: StepReport) -> StepReport {
    step.status = StepStatus::Cancelled;
    step.reason = Some("Cancelled".into());
    step
}

fn failed(mut step: StepReport, reason: impl Into<String>) -> StepReport {
    step.status = StepStatus::Failed;
    step.reason = Some(reason.into());
    step
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
        return failed(step, reason);
    }
    step.status = StepStatus::Passed;
    step
}

/// The installed copy's catalog commit, from its install record.
fn version_of(record: &std::path::Path) -> Option<String> {
    crate::model_catalog::installed::read_record(record).map(|record| record.commit.chars().take(12).collect())
}

// --- Parakeet --------------------------------------------------------------

/// Where Parakeet's encoder goes for `model`, read as `ParakeetModel::new`
/// and `npu::state::encoder_for_load` decide it.
fn parakeet_picked(model: &str, inputs: &mut Vec<(String, String)>) -> Device {
    let labs = crate::parakeet_engine::labs::enabled();
    inputs.push(("Parakeet on the GPU (Labs)".into(), if labs { "on" } else { "off" }.into()));
    #[cfg(windows)]
    {
        use crate::parakeet_engine::npu::state::{self, NpuState, MODEL_ID};
        let npu = state::status();
        inputs.push(("Intel NPU".into(), if npu.present { format!("{:?}", npu.state).to_lowercase() } else { "none".into() }));
        if let Some(reason) = &npu.reason {
            inputs.push(("Intel NPU reason".into(), reason.clone()));
        }
        if model == MODEL_ID && npu.state == NpuState::Ready {
            return Device { name: "Intel NPU".into(), why: "the NPU is prepared for Parakeet v3".into() };
        }
        if labs && !state::overrides_labs() {
            return Device { name: "GPU (DirectML adapter 0)".into(), why: "Parakeet on the GPU is on in Labs".into() };
        }
        let why = if npu.present && model != MODEL_ID {
            "the Intel NPU runs only Parakeet v3"
        } else if npu.present {
            "the Intel NPU is not ready"
        } else {
            "no Intel NPU, and Parakeet on the GPU is off"
        };
        Device { name: PROCESSOR.into(), why: why.into() }
    }
    #[cfg(not(windows))]
    {
        let _ = model;
        let why = if labs { "Parakeet on the GPU is Windows only" } else { "Parakeet runs on the processor here" };
        Device { name: PROCESSOR.into(), why: why.into() }
    }
}

async fn parakeet_ran_on(engine: &ParakeetEngine, picked: &Device) -> String {
    if engine.uses_npu().await {
        "Intel NPU".into()
    } else if picked.name.starts_with("GPU (DirectML") {
        // The encoder session is built with `error_on_failure`: a load that
        // succeeded has DirectML, a failed one is the step's error.
        picked.name.clone()
    } else {
        PROCESSOR.into()
    }
}

#[cfg(windows)]
fn npu_reason() -> String {
    crate::parakeet_engine::npu::state::status().reason.unwrap_or_else(|| "the NPU did not start".into())
}

#[cfg(not(windows))]
fn npu_reason() -> String {
    String::new()
}

/// Parakeet through the live path: the pieces the live VAD cuts (its
/// thresholds, redemption time and cap, `audio::pipeline`) and
/// the live call with its windows (`chunking::Live`), as the live worker
/// and the measuring kit's `parakeet-live` setting run them. It records
/// whether Parakeet keeps up with a meeting.
pub async fn parakeet(model: &str, context: &Context<'_>) -> StepReport {
    let mut step = StepReport::new(StepKind::Parakeet, StepStatus::Failed);
    step.model = Some(ModelId { id: model.into(), version: None });
    let picked = parakeet_picked(model, &mut step.inputs);
    step.picked = Some(picked.clone());

    let engine = match ParakeetEngine::new_with_models_dir(Some(crate::paths::models_dir())) {
        Ok(engine) => engine,
        Err(error) => return failed(step, format!("Parakeet did not start: {error}")),
    };
    match engine.discover_models().await {
        Ok(models) => match models.iter().find(|info| info.name == model) {
            Some(info) => step.model = Some(ModelId { id: model.into(), version: version_of(&crate::model_catalog::installed::record_path_for_dir(&info.path)) }),
            None => return failed(step, format!("Parakeet has no model {model}")),
        },
        Err(error) => return failed(step, format!("Parakeet's models could not be listed: {error}")),
    }
    if (context.cancelled)() {
        return cancelled_step(step);
    }
    let started = Instant::now();
    if let Err(error) = engine.load_model(model).await {
        return failed(step, format!("Parakeet did not load: {error}"));
    }
    step.load_ms = Some(ms(started));
    let ran_on = parakeet_ran_on(&engine, &picked).await;
    if picked.name == "Intel NPU" && ran_on != "Intel NPU" {
        step.fallback = Some(Fallback { from: picked.name.clone(), to: ran_on.clone(), error: npu_reason() });
    }

    let real_time = crate::audio::recording_preferences::is_real_time_transcription();
    let live_redemption = live_redemption_ms(real_time);
    step.inputs.push(("Faster live text".into(), if real_time { "on" } else { "off" }.into()));
    let mut total_audio = 0.0;
    let mut total_processing = 0.0;
    for clip in context.clips {
        if (context.cancelled)() {
            return cancelled_step(step);
        }
        // The live pipeline's VAD: its thresholds and redemption time (Faster
        // live text's when it is on), capped as it caps a segment.
        let pieces = match crate::audio::vad::get_speech_chunks_with_cap_and_progress(
            &clip.samples,
            live_redemption,
            LIVE_POSITIVE_SPEECH_THRESHOLD,
            LIVE_NEGATIVE_SPEECH_THRESHOLD,
            crate::audio::vad::ContinuousSpeechCap::Streaming,
            |_, _| !(context.cancelled)(),
        ) {
            Ok(pieces) => pieces,
            Err(error) => return failed(step, format!("The VAD failed on the {} clip: {error}", clip.id)),
        };
        let mut live = Live::default();
        let mut texts: Vec<String> = Vec::new();
        let started = Instant::now();
        for piece in &pieces {
            if (context.cancelled)() {
                return cancelled_step(step);
            }
            if !live.continues(piece.start_timestamp_ms) {
                if let Some(held) = live.flush() {
                    texts.push(chunking::text(&held.words));
                }
            }
            match engine.transcribe_live(&mut live, piece.start_timestamp_ms, piece.samples.clone(), piece.capped, None).await {
                Ok(text) => {
                    log::debug!(
                        "[speech check] Parakeet {}: piece {:.2}-{:.2} s{}: {text:?}",
                        clip.id,
                        piece.start_timestamp_ms / 1000.0,
                        piece.end_timestamp_ms / 1000.0,
                        if piece.capped { " (capped)" } else { "" }
                    );
                    texts.push(text)
                }
                Err(error) => return failed(step, format!("Parakeet failed on the {} clip: {error}", clip.id)),
            }
        }
        if let Some(held) = live.flush() {
            texts.push(chunking::text(&held.words));
        }
        let processing_ms = ms(started);
        let text = texts.iter().map(|text| text.trim()).filter(|text| !text.is_empty()).collect::<Vec<_>>().join(" ");
        let errors = score::word_errors(&clip.text(), &text);
        total_audio += clip.duration_ms();
        total_processing += processing_ms;
        step.clips.push(ClipResult {
            clip: clip.id.clone(),
            audio_ms: clip.duration_ms(),
            processing_ms,
            real_time_factor: processing_ms / clip.duration_ms(),
            text: Some(text),
            language: None,
            word_errors: Some(errors),
            word_error_rate: Some(errors.rate()),
            speakers: None,
            passed: score::transcript_passes(&errors),
        });
    }
    // The NPU can fail during a call and leave the rest to the processor.
    let after = parakeet_ran_on(&engine, &picked).await;
    if after != ran_on && step.fallback.is_none() {
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

/// Where whisper.cpp runs a context here, as `context_parameters` decides.
fn whisper_cpp_device() -> Device {
    use crate::whisper_engine::acceleration::{whisper_gpu, WhisperCompiledBackend};
    let (_, acceleration) = crate::whisper_engine::whisper_engine::context_parameters(crate::audio::HardwareProfile::detect());
    let backend = acceleration.compiled_backend;
    if acceleration.use_gpu {
        return match backend {
            WhisperCompiledBackend::Vulkan => {
                let name = whisper_gpu(backend).map(|gpu| gpu.name).unwrap_or_else(|| format!("device {}", acceleration.gpu_device));
                Device { name: format!("GPU (Vulkan): {name}"), why: "the first discrete GPU ggml lists, else its first GPU".into() }
            }
            WhisperCompiledBackend::Metal => Device { name: "Apple GPU (Metal)".into(), why: "the macOS build runs Whisper on Metal".into() },
            other => Device { name: format!("GPU ({})", other.as_str()), why: "this build's GPU backend".into() },
        };
    }
    let why = match (backend, crate::whisper_engine::vulkan::stopped()) {
        (_, Some(stopped)) => stopped,
        (WhisperCompiledBackend::Cpu, None) => "this build of Protocol runs Whisper on the processor".into(),
        (_, None) => "ggml lists no GPU here".into(),
    };
    Device { name: PROCESSOR.into(), why }
}

/// An OpenVINO device in the one form "picked" and "ran on" both use, so
/// the two compare equal when OpenVINO runs where it was picked.
#[cfg(any(windows, target_os = "linux"))]
fn openvino_name(device: &str) -> String {
    format!("Intel GPU (OpenVINO {})", device.trim())
}

/// The device the loaded engine runs on.
fn whisper_ran_on(engine: &WhisperEngine) -> String {
    #[cfg(any(windows, target_os = "linux"))]
    if let Some(loaded) = engine.loaded_openvino() {
        return openvino_name(loaded.device());
    }
    let _ = engine;
    whisper_cpp_device().name
}

/// Where `model` loads, as `WhisperEngine::load_model` decides: the Intel GPU
/// version on OpenVINO, or a ggml model's installed OpenVINO companion in its
/// place (#79, #88), when OpenVINO picks a device and its crash guard is off;
/// otherwise whisper.cpp.
async fn whisper_picked(model: &str, inputs: &mut Vec<(String, String)>) -> Device {
    let cpp = whisper_cpp_device();
    inputs.push(("Whisper build".into(), crate::whisper_engine::acceleration::WhisperCompiledBackend::current().as_str().into()));
    if let Some(stopped) = crate::whisper_engine::vulkan::stopped() {
        inputs.push(("Vulkan crash guard".into(), stopped));
    }
    inputs.push(("whisper.cpp would use".into(), format!("{} ({})", cpp.name, cpp.why)));
    #[cfg(any(windows, target_os = "linux"))]
    {
        use crate::whisper_engine::openvino;
        let gpu_version = crate::speech_choice::gpu_version(model);
        let companion = match &gpu_version {
            Some(version) => crate::speech_choice::installed(version).map(|companion| companion.dir),
            None => crate::model_catalog::openvino::installed_companion(model).map(|companion| companion.dir),
        };
        inputs.push(("Intel GPU version".into(), match (&gpu_version, &companion) {
            (Some(_), Some(_)) => "chosen, installed".into(),
            (Some(_), None) => "chosen, not installed".into(),
            (None, Some(_)) => "installed for this model".into(),
            (None, None) => "none".into(),
        }));
        let availability = openvino::availability().await;
        inputs.push(("OpenVINO offered".into(), if availability.offer { "yes" } else { "no" }.into()));
        if let Some(gpu) = &availability.gpu {
            inputs.push(("OpenVINO GPU".into(), gpu.clone()));
        }
        for (name, value) in [("OpenVINO device", &availability.device), ("OpenVINO mismatch", &availability.mismatch), ("OpenVINO not offered because", &availability.reason), ("Intel OpenCL driver", &availability.driver)] {
            if let Some(value) = value {
                inputs.push((name.into(), value.clone()));
            }
        }
        let stopped = openvino::stopped();
        if let Some(stopped) = &stopped {
            inputs.push(("OpenVINO crash guard".into(), stopped.clone()));
        }
        if companion.is_some() {
            match (&availability.device, &stopped) {
                (Some(device), None) => {
                    return Device { name: openvino_name(device), why: "the Intel GPU version is installed and OpenVINO runs on whisper.cpp's GPU".into() };
                }
                (_, Some(stopped)) => return Device { name: cpp.name, why: format!("the Intel GPU version is off: {stopped}") },
                (None, None) => {
                    let why = availability.mismatch.clone().unwrap_or_else(|| "OpenVINO picks no device here".into());
                    return Device { name: cpp.name, why: format!("the Intel GPU version cannot run: {why}") };
                }
            }
        }
        if gpu_version.is_some() {
            return Device { name: cpp.name, why: "the Intel GPU version is not installed, so a regular copy runs".into() };
        }
    }
    let _ = model;
    cpp
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
    let mut step = StepReport::new(StepKind::Whisper, StepStatus::Failed);
    step.model = Some(ModelId { id: model.into(), version: None });
    let picked = whisper_picked(model, &mut step.inputs).await;
    step.picked = Some(picked.clone());

    let engine = match WhisperEngine::new_with_models_dir(Some(crate::paths::models_dir())) {
        Ok(engine) => engine,
        Err(error) => return failed(step, format!("Whisper did not start: {error}")),
    };
    match engine.discover_models().await {
        Ok(models) => {
            if let Some(record) = whisper_record(&models, model) {
                step.model = Some(ModelId { id: model.into(), version: version_of(&record) });
            }
        }
        Err(error) => return failed(step, format!("Whisper's models could not be listed: {error}")),
    }
    if (context.cancelled)() {
        return cancelled_step(step);
    }
    let started = Instant::now();
    if let Err(error) = engine.load_model(model).await {
        return failed(step, format!("Whisper did not load: {error}"));
    }
    step.load_ms = Some(ms(started));
    let ran_on = whisper_ran_on(&engine);
    if ran_on != picked.name {
        #[cfg(any(windows, target_os = "linux"))]
        let error = crate::whisper_engine::openvino::backend_status().and_then(|status| status.fallback_reason);
        #[cfg(not(any(windows, target_os = "linux")))]
        let error: Option<String> = None;
        step.fallback = Some(Fallback { from: picked.name.clone(), to: ran_on.clone(), error: error.unwrap_or_else(|| "no reason was recorded".into()) });
    }
    step.ran_on = Some(ran_on.clone());

    const TRACK: &str = "mixed audio";
    for clip in context.clips {
        if (context.cancelled)() {
            return cancelled_step(step);
        }
        let segments = match post_meeting::speech(
            &clip.samples,
            DEFAULT_POSITIVE_SPEECH_THRESHOLD,
            DEFAULT_NEGATIVE_SPEECH_THRESHOLD,
            post_meeting::vad_cap(false),
            |_, _| !(context.cancelled)(),
        ) {
            Ok(segments) => segments,
            Err(error) => return failed(step, format!("The VAD failed on the {} clip: {error}", clip.id)),
        };
        let pieces = post_meeting::pieces(segments.into_iter().map(|segment| (segment, TRACK)).collect());
        let started = Instant::now();
        let mut pass = Pass::new(None, Some(&engine), None, None).dropping_silence_hallucinations();
        pass.detect_languages(pieces.iter().map(|(segment, track)| (segment, *track)), || (context.cancelled)()).await;
        let mut texts = Vec::new();
        for (piece, track) in &pieces {
            if (context.cancelled)() {
                return cancelled_step(step);
            }
            match pass.transcribe(piece, *track).await {
                Ok(PieceOutcome::Rows(rows)) => texts.extend(rows.into_iter().map(|(text, _, _)| text)),
                Ok(PieceOutcome::Skipped(_) | PieceOutcome::Dropped(_)) => {}
                Err(error) => return failed(step, format!("Whisper failed on the {} clip: {error}", clip.id)),
            }
        }
        let processing_ms = ms(started);
        let text = texts.iter().map(|text| text.trim()).filter(|text| !text.is_empty()).collect::<Vec<_>>().join(" ");
        let errors = score::word_errors(&clip.text(), &text);
        step.clips.push(ClipResult {
            clip: clip.id.clone(),
            audio_ms: clip.duration_ms(),
            processing_ms,
            real_time_factor: processing_ms / clip.duration_ms(),
            text: Some(text),
            language: pass.detected_language(TRACK).map(str::to_string),
            word_errors: Some(errors),
            word_error_rate: Some(errors.rate()),
            speakers: None,
            passed: score::transcript_passes(&errors),
        });
    }
    engine.unload_model().await;
    finish(step)
}

// --- Speakers --------------------------------------------------------------

/// 16 kHz mono 32-bit float, which `dsp::read_wav` reads, as the measuring
/// kit writes a track for the speaker engines (`measure/diarize.rs`).
fn write_wav(path: &std::path::Path, samples: &[f32]) -> std::io::Result<()> {
    use std::io::Write;
    let data_bytes = u32::try_from(samples.len() * 4).map_err(std::io::Error::other)?;
    let mut out = std::io::BufWriter::new(std::fs::File::create(path)?);
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + data_bytes).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16u32.to_le_bytes())?;
    out.write_all(&3u16.to_le_bytes())?; // IEEE float
    out.write_all(&1u16.to_le_bytes())?; // mono
    out.write_all(&16_000u32.to_le_bytes())?;
    out.write_all(&(16_000u32 * 4).to_le_bytes())?;
    out.write_all(&4u16.to_le_bytes())?;
    out.write_all(&32u16.to_le_bytes())?;
    out.write_all(b"data")?;
    out.write_all(&data_bytes.to_le_bytes())?;
    for sample in samples {
        out.write_all(&sample.to_le_bytes())?;
    }
    out.flush()
}

/// A speaker engine on each clip, as an import diarizes a file: the whole
/// clip as one track (`diarize_file_with_engine`), with the saved settings.
async fn speakers(kind: StepKind, engine_name: &'static str, context: &Context<'_>, mut step: StepReport) -> StepReport {
    let folder = match tempfile::tempdir() {
        Ok(folder) => folder,
        Err(error) => return failed(step, format!("No folder for the sample: {error}")),
    };
    for clip in context.clips {
        if (context.cancelled)() {
            return cancelled_step(step);
        }
        let wav = folder.path().join(format!("{}.wav", clip.id));
        if let Err(error) = write_wav(&wav, &clip.samples) {
            return failed(step, format!("The {} clip could not be written: {error}", clip.id));
        }
        let started = Instant::now();
        let path = wav.clone();
        let result = tokio::task::spawn_blocking(move || crate::diarization::diarize_file_with_engine(&path, engine_name, None, None)).await;
        let processing_ms = ms(started);
        let result = match result {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => return failed(step, format!("{} failed on the {} clip: {error}", kind.title(), clip.id)),
            Err(error) => return failed(step, format!("{} stopped on the {} clip: {error}", kind.title(), clip.id)),
        };
        let found: Vec<score::Turn<usize>> = result
            .segments
            .iter()
            .map(|segment| score::Turn { start_ms: segment.start as f64 * 1000.0, end_ms: segment.end as f64 * 1000.0, label: segment.speaker })
            .collect();
        log::debug!(
            "[speech check] {engine_name} {}: {}",
            clip.id,
            found.iter().map(|turn| format!("{:.2}-{:.2}={}", turn.start_ms / 1000.0, turn.end_ms / 1000.0, turn.label)).collect::<Vec<_>>().join(" ")
        );
        let speakers = score::speaker_score(&clip.voices(), &found);
        step.clips.push(ClipResult {
            clip: clip.id.clone(),
            audio_ms: clip.duration_ms(),
            processing_ms,
            real_time_factor: processing_ms / clip.duration_ms(),
            text: None,
            language: None,
            word_errors: None,
            word_error_rate: None,
            speakers: Some(speakers),
            passed: score::speakers_pass(&speakers),
        });
    }
    finish(step)
}

/// Pyannote's segmentation and WeSpeaker's embeddings, which run on ONNX
/// Runtime's CPU provider on every platform (`diarization/models.rs`).
pub async fn pyannote(context: &Context<'_>) -> StepReport {
    let mut step = StepReport::new(StepKind::Pyannote, StepStatus::Failed);
    step.model = Some(ModelId { id: "pyannote segmentation 3.0 + WeSpeaker ResNet34".into(), version: Some("bundled".into()) });
    let processor = Device { name: PROCESSOR.into(), why: "Pyannote and WeSpeaker run on ONNX Runtime's CPU provider on every platform".into() };
    step.picked = Some(processor.clone());
    if !crate::diarization::pyannote_models_available() {
        return StepReport::new(StepKind::Pyannote, StepStatus::NotChecked).with_reason("The speaker models are not in this copy of Protocol");
    }
    step.ran_on = Some(processor.name);
    speakers(StepKind::Pyannote, "pyannote", context, step).await
}

/// Nemotron: DirectML adapter 0 on Windows, with a CPU session after
/// DirectML fails (`sortformer/support.rs`); the CPU elsewhere.
pub async fn nemotron(context: &Context<'_>) -> StepReport {
    let mut step = StepReport::new(StepKind::Nemotron, StepStatus::Failed);
    step.model = Some(ModelId { id: crate::diarization::nemotron::NEMOTRON_MODEL_FILENAME.into(), version: Some(crate::diarization::nemotron::NEMOTRON_SHA256[..12].into()) });
    let picked = if cfg!(windows) {
        Device { name: "GPU (DirectML adapter 0)".into(), why: "Nemotron asks DirectML first on Windows".into() }
    } else {
        Device { name: PROCESSOR.into(), why: "Nemotron runs on ONNX Runtime's CPU provider outside Windows".into() }
    };
    step.picked = Some(picked.clone());
    if !crate::diarization::nemotron_models_available() {
        return StepReport::new(StepKind::Nemotron, StepStatus::NotChecked).with_reason("Nemotron is not downloaded");
    }
    crate::diarization::nemotron::forget_last_session();
    let mut step = speakers(StepKind::Nemotron, "nemotron", context, step).await;
    if let Some((provider, directml_error)) = crate::diarization::nemotron::last_session() {
        let ran_on = if provider == "DirectML" { picked.name.clone() } else { PROCESSOR.to_string() };
        if ran_on != picked.name {
            step.fallback = Some(Fallback {
                from: picked.name.clone(),
                to: ran_on.clone(),
                error: directml_error.unwrap_or_else(|| "no reason was recorded".into()),
            });
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
    fn the_wav_for_the_speaker_engines_reads_back() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("clip.wav");
        write_wav(&path, &[0.0, 0.5, -0.25]).unwrap();
        assert_eq!(crate::diarization::dsp::read_wav(&path).unwrap(), (vec![0.0, 0.5, -0.25], 16_000));
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn openvino_is_named_in_one_form_for_picked_and_ran_on() {
        assert_eq!(openvino_name("GPU"), "Intel GPU (OpenVINO GPU)");
        assert_eq!(openvino_name(" GPU.1 "), openvino_name("GPU.1"));
    }
}
