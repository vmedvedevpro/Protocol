//! NPU probes for #66, run by `scripts/npu-bench/` (its README has the
//! commands and what each answers):
//!
//! - [`ort_plugin_smoke`]: does Intel's OpenVINO plugin EP load into the
//!   app's bundled ONNX Runtime (1.24.4, the DirectML build) through `ort`,
//!   which devices does it list, and does a Parakeet encoder session built on
//!   the NPU device run and agree with the CPU encoder?
//! - [`paced_live`]: the live-like sustained scenario on the product's own
//!   engines, one 6 s window every 6 s, for the power comparison with the
//!   NPU. Whisper is the live worker's call (whisper.cpp, Vulkan in a Vulkan
//!   build); Parakeet the pass's engine, on the CPU or, with the Labs switch
//!   in the test binary's data folder, its DirectML encoder.
//! - [`paced_meeting`] (#80): a simulated live meeting on the product's
//!   engines. Parakeet transcribes the fixture's VAD pieces at the pace the
//!   live worker gets them, on the CPU, its DirectML encoder or an NPU
//!   encoder session swapped into the product's model, while live Nemotron
//!   diarizes the same audio as the remote track, as the app does during a
//!   meeting with Nemotron selected.

use std::io::Write;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use ndarray::{s, Array1, Array2, Array3, ArrayD};
use ort::memory::DeviceType;
use ort::session::Session;
use ort::value::TensorRef;

use super::engines::Engines;
use super::input::{existing_path, optional};
use super::{ms_since, tracks, SAMPLES_PER_MS};

fn unix_now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

/// Appends a phase to `BENCH_MARKS` in `scripts/npu-bench/marks.py`'s format,
/// when `bench.py` runs the test; its energy is read between `t0` and `t1`.
fn mark(phase: &str, t0: f64, t1: f64, fields: serde_json::Value) -> Result<()> {
    let Some(path) = optional("BENCH_MARKS") else { return Ok(()) };
    let mut record = serde_json::json!({ "phase": phase, "t0": t0, "t1": t1 });
    if let (Some(record), Some(fields)) = (record.as_object_mut(), fields.as_object()) {
        record.extend(fields.clone());
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{record}")?;
    Ok(())
}

/// The first `seconds` of the audio file's only track.
fn audio_head(seconds: f64) -> Result<Vec<f32>> {
    let audio = existing_path("MEASURE_AUDIO", "a 16 kHz speech file")?;
    let mut track = tracks::load(&audio)?.into_iter().next().context("the audio has no track")?;
    track.samples.truncate((seconds * 1000.0 * SAMPLES_PER_MS) as usize);
    Ok(track.samples)
}

/// `key=value;key=value` provider options from `NPU_EP_OPTIONS`.
fn ep_options() -> Vec<(String, String)> {
    optional("NPU_EP_OPTIONS")
        .unwrap_or_default()
        .split(';')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect()
}

fn encode(session: &mut Session, features: &ArrayD<f32>, length: i64) -> Result<(ArrayD<f32>, i64)> {
    let length = Array1::from_vec(vec![length]);
    let outputs = session.run(ort::inputs![
        "audio_signal" => TensorRef::from_array_view(features.view())?,
        "length" => TensorRef::from_array_view(length.view())?,
    ])?;
    let encoded = outputs["outputs"].try_extract_array::<f32>()?.to_owned();
    let frames = outputs["encoded_lengths"].try_extract_array::<i64>()?[0];
    Ok((encoded, frames))
}

fn first_line(text: &str) -> &str {
    text.lines().find(|line| !line.trim().is_empty()).unwrap_or(text)
}

/// A session on ONNX Runtime's own CPU EP device, named explicitly.
fn cpu_session(environment: &ort::environment::Environment, model: &std::path::Path) -> ort::Result<Session> {
    let cpu: Vec<_> = environment.devices().filter(|d| d.ep().is_ok_and(|ep| ep == "CPUExecutionProvider")).collect();
    Session::builder(environment)?
        .with_intra_op_spinning(false)?
        .with_inter_op_spinning(false)?
        .with_devices(cpu, None)?
        .commit_from_file(model)
}

/// A session on the plugin's NPU device that refuses CPU fallback, so one
/// that builds runs the whole graph inside the OpenVINO EP.
fn npu_session(
    environment: &ort::environment::Environment,
    devices: Vec<ort::device::Device<'_>>,
    options: &[(String, String)],
    model: &std::path::Path,
) -> ort::Result<Session> {
    Session::builder(environment)?
        .with_intra_op_spinning(false)?
        .with_inter_op_spinning(false)?
        .with_config_entry("session.disable_cpu_ep_fallback", "1")?
        .with_devices(devices, Some(options))?
        .commit_from_file(model)
}

/// Inputs: `NPU_EP_PLUGIN` (`onnxruntime_providers_openvino_plugin.dll`, with
/// its OpenVINO DLLs beside it), `MEASURE_PARAKEET_MODEL`, `MEASURE_AUDIO`,
/// and optionally `NPU_EP_OPTIONS` and `NPU_FRAMES` (the static feature
/// length the features are padded to).
///
/// `NPU_EP_OPTIONS` holds the plugin's provider options as `key=value;...`.
/// `ort`'s `with_devices` passes on only keys prefixed with the EP's name and
/// silently drops the others, so they read
/// `OpenVINOExecutionProvider.reshape_input=audio_signal[1,128,608],length[1]`.
/// The plugin ignores `cache_dir` (with a warning); its compile cache is
/// OpenVINO's `CACHE_DIR` in the JSON file named by
/// `OpenVINOExecutionProvider.load_config` (`{"NPU": {"CACHE_DIR": "..."}}`).
#[test]
#[ignore = "NPU probe (#66); inputs from NPU_* and MEASURE_* (scripts/npu-bench/README.md)"]
fn ort_plugin_smoke() -> Result<()> {
    let _ = env_logger::builder().is_test(true).try_init();
    let plugin = existing_path("NPU_EP_PLUGIN", "onnxruntime_providers_openvino_plugin.dll")?;
    let model = existing_path("MEASURE_PARAKEET_MODEL", "the Parakeet model folder")?;
    let environment = crate::onnx_runtime::environment()?;
    println!("ONNX Runtime: {}", ort::info());

    let started = Instant::now();
    let registered = environment.register_ep_library("OpenVINOExecutionProvider", &plugin);
    println!("register_ep_library({}): {:?} in {:.0} ms", plugin.display(), registered, ms_since(started));
    registered.context("registering the OpenVINO plugin EP")?;
    for device in environment.devices() {
        let hardware = device.hardware_device();
        println!(
            "device: ep={} ep_vendor={} type={:?} vendor={} id={:#x}",
            device.ep()?, device.ep_vendor()?, hardware.ty(), hardware.vendor().unwrap_or("?"), hardware.id()
        );
    }
    let npu: Vec<_> = environment
        .devices()
        .filter(|d| d.ep().is_ok_and(|ep| ep == "OpenVINOExecutionProvider") && d.hardware_device().ty() == DeviceType::NPU)
        .collect();
    if npu.is_empty() {
        bail!("the OpenVINO EP lists no NPU device");
    }

    // The app's CPU sessions name the CPU through the PreferCPU policy
    // (`onnx_runtime::session_builder`). Once the plugin is registered, the
    // OpenVINO EP offers a CPU device too, and the policy may pick it: try the
    // app's builder on the preprocessor and report where it went.
    match crate::onnx_runtime::session_builder(environment).and_then(|mut b| b.commit_from_file(model.join("nemo128.onnx"))) {
        Ok(_) => println!("app session_builder (PreferCPU) on nemo128.onnx: builds"),
        Err(error) => println!("app session_builder (PreferCPU) on nemo128.onnx fails: {}", first_line(&error.to_string())),
    }

    // The features of the audio's first 6 s, padded to the static length.
    let samples = audio_head(6.0)?;
    let mut preprocessor = cpu_session(environment, &model.join("nemo128.onnx"))?;
    let waveform = Array2::from_shape_vec((1, samples.len()), samples)?;
    let waveform_len = Array1::from_vec(vec![waveform.ncols() as i64]);
    let outputs = preprocessor.run(ort::inputs![
        "waveforms" => TensorRef::from_array_view(waveform.view())?,
        "waveforms_lens" => TensorRef::from_array_view(waveform_len.view())?,
    ])?;
    let features = outputs["features"].try_extract_array::<f32>()?.to_owned();
    let length = outputs["features_lens"].try_extract_array::<i64>()?[0];
    drop(outputs);
    let frames = optional("NPU_FRAMES").map(|v| v.parse::<usize>()).transpose()?.unwrap_or(features.shape()[2]);
    let mut padded = Array3::<f32>::zeros((1, features.shape()[1], frames));
    padded.slice_mut(s![.., .., ..features.shape()[2]]).assign(&features.view().into_dimensionality::<ndarray::Ix3>()?);
    let padded = padded.into_dyn();
    println!("features: {} frames, padded to {frames}", features.shape()[2]);

    let encoder = model.join("encoder-model.int8.onnx");
    let mut cpu = cpu_session(environment, &encoder)?;
    let (reference, reference_frames) = encode(&mut cpu, &padded, length)?;

    let options = ep_options();
    let started = Instant::now();
    let built = npu_session(environment, npu, &options, &encoder);
    let compile_ms = ms_since(started);
    let mut session = match built {
        Ok(session) => session,
        Err(error) => bail!("the NPU encoder session failed after {compile_ms:.0} ms: {error}"),
    };
    println!("NPU encoder session built in {compile_ms:.0} ms with options {options:?}");

    let mut times = Vec::new();
    let mut encoded = None;
    for _ in 0..6 {
        let started = Instant::now();
        encoded = Some(encode(&mut session, &padded, length)?);
        times.push(ms_since(started));
    }
    let (encoded, encoded_frames) = encoded.context("no run")?;
    let first = times[0];
    let valid = reference_frames.min(encoded_frames) as usize;
    let a = reference.slice(s![.., .., ..valid]);
    let b = encoded.slice(s![.., .., ..valid]);
    let max_diff = (&a - &b).iter().fold(0.0f32, |m, d| m.max(d.abs()));
    let scale = a.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    times[1..].sort_by(f64::total_cmp);
    println!(
        "NPU encoder runs: first {:.1} ms, median of the next five {:.1} ms; frames {encoded_frames} (CPU {reference_frames}); \
         max |NPU - CPU| {max_diff:.4} over max |CPU| {scale:.4}",
        first, times[1 + (times.len() - 1) / 2]
    );
    Ok(())
}

/// Inputs: `MEASURE_AUDIO`, `PACED_ENGINE` (`whisper` or `parakeet`), its
/// model (`MEASURE_WHISPER_MODEL` or `MEASURE_PARAKEET_MODEL`),
/// `MEASURE_LANGUAGE` for Whisper, and optionally `PACED_SECONDS` (300) and
/// `PACED_PERIOD` (6). Consecutive windows of the audio, from its start and
/// around again, one per period; the phase `paced` lasts whole periods.
#[tokio::test]
#[ignore = "NPU probe (#66); inputs from PACED_* and MEASURE_* (scripts/npu-bench/README.md)"]
async fn paced_live() -> Result<()> {
    let _ = env_logger::builder().is_test(true).try_init();
    let seconds: f64 = optional("PACED_SECONDS").map_or(Ok(300.0), |v| v.parse())?;
    let period: f64 = optional("PACED_PERIOD").map_or(Ok(6.0), |v| v.parse())?;
    let whisper = optional("PACED_ENGINE").as_deref() == Some("whisper");
    let audio = existing_path("MEASURE_AUDIO", "a 16 kHz speech file")?;
    let samples = tracks::load(&audio)?.into_iter().next().context("the audio has no track")?.samples;
    let window = (period * 1000.0 * SAMPLES_PER_MS) as usize;
    let calls = (seconds / period) as usize;
    let looped: Vec<f32> = samples.iter().copied().cycle().take(window * calls).collect();
    let language = optional("MEASURE_LANGUAGE");

    let started = (unix_now(), Instant::now());
    let engines = if whisper {
        Engines::open(Some(&existing_path("MEASURE_WHISPER_MODEL", "the ggml model")?), None).await?
    } else {
        Engines::open(None, Some(&existing_path("MEASURE_PARAKEET_MODEL", "the Parakeet model folder")?)).await?
    };
    mark("load", started.0, unix_now(), serde_json::json!({}))?;
    let acceleration = if whisper { engines.whisper.as_ref().map(|l| l.acceleration) } else { engines.parakeet.as_ref().map(|l| l.acceleration) };
    println!("engine: {} on {}", if whisper { "whisper" } else { "parakeet" }, acceleration.unwrap_or("?"));
    let transcribe = |piece: Vec<f32>| async {
        if whisper {
            let engine = &engines.whisper.as_ref().context("no Whisper engine")?.engine;
            Ok::<String, anyhow::Error>(engine.transcribe_audio_with_confidence(piece, language.clone(), None).await?.0)
        } else {
            engines.parakeet.as_ref().context("no Parakeet engine")?.engine.transcribe_audio(piece, None).await
        }
    };

    let t0 = unix_now();
    transcribe(looped[..window].to_vec()).await?;
    mark("warmup", t0, unix_now(), serde_json::json!({}))?;

    let mut latencies = Vec::with_capacity(calls);
    let mut late = 0;
    let start = Instant::now();
    let t0 = unix_now();
    for (i, piece) in looped.chunks(window).enumerate() {
        let due = std::time::Duration::from_secs_f64(i as f64 * period);
        match due.checked_sub(start.elapsed()) {
            Some(wait) => tokio::time::sleep(wait).await,
            None => late += usize::from(i > 0),
        }
        let began = Instant::now();
        let text = transcribe(piece.to_vec()).await?;
        latencies.push(ms_since(began));
        log::debug!("{i}: {text}");
    }
    let end = std::time::Duration::from_secs_f64(calls as f64 * period);
    if let Some(wait) = end.checked_sub(start.elapsed()) {
        tokio::time::sleep(wait).await;
    }
    let mut sorted = latencies.clone();
    sorted.sort_by(f64::total_cmp);
    let median = sorted[sorted.len() / 2];
    let busy = latencies.iter().sum::<f64>() / 1000.0 / (calls as f64 * period);
    mark("paced", t0, unix_now(), serde_json::json!({
        "audio_s": calls as f64 * period, "calls": calls, "period_s": period, "late_calls": late,
        "latency_ms_median": median, "latency_ms_max": sorted[sorted.len() - 1], "busy_share": busy,
    }))?;
    println!("paced: {calls} calls, median {median:.0} ms, max {:.0} ms, busy {:.1} %, late {late}", sorted[sorted.len() - 1], busy * 100.0);
    Ok(())
}

/// One simulated speech turn of [`paced_meeting`]: its place on the meeting's
/// timeline (16 kHz samples) and when the live worker would get it.
struct Turn {
    start: usize,
    end: usize,
    due_s: f64,
}

/// The fixture's VAD pieces (the kit's `parakeet.json`: the live setting's
/// pieces of at most 6 s, which the live worker gets one by one as the VAD
/// closes them), looped over `seconds`. A piece is due when it ends: the
/// pipeline queues a turn once the VAD closes it, and the redemption time
/// after the speech only shifts every turn by the same delay.
fn turns(pieces: &std::path::Path, audio_len: usize, seconds: f64) -> Result<Vec<Turn>> {
    let kit: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(pieces)?)?;
    let mut spans = Vec::new();
    for piece in kit["pieces"].as_array().context("no pieces")? {
        if piece["skipped"].is_null() {
            let ms = |key: &str| piece[key].as_f64().context("piece without times");
            spans.push(((ms("start_ms")? * SAMPLES_PER_MS) as usize, (ms("end_ms")? * SAMPLES_PER_MS) as usize));
        }
    }
    let total = (seconds * 1000.0 * SAMPLES_PER_MS) as usize;
    let mut out = Vec::new();
    for offset in (0..total).step_by(audio_len) {
        for &(start, end) in &spans {
            if offset + end <= total {
                out.push(Turn { start: offset + start, end: offset + end, due_s: (offset + end) as f64 / 16_000.0 });
            }
        }
    }
    Ok(out)
}

/// Inputs: `MEASURE_AUDIO`, `MEASURE_PARAKEET_MODEL`, `PACED_PIECES` (the
/// kit's `parakeet.json` for that audio), `PACED_DEVICE` (`cpu`, `dml` or
/// `npu`), and optionally `PACED_SECONDS` (1800), `PACED_OUT` (a JSON file
/// with every call), `PACED_STATIC_FRAMES` (pad the features to this length;
/// `npu` takes `NPU_FRAMES`), `PACED_ENGINE=none` (diarization alone, no
/// Parakeet calls), and `MEASURE_DIARIZATION_MODEL` (the Nemotron `.onnx`;
/// without it no diarization runs) with `PACED_NEMOTRON_THRESHOLD` (0.5, the
/// app's default). `npu` also reads `NPU_EP_PLUGIN` and `NPU_EP_OPTIONS` as
/// [`ort_plugin_smoke`] does.
///
/// What runs is the app's live path without capture and VAD: the remote
/// track's audio goes to `live_nemotron` in 50 ms windows at real-time pace
/// (the pipeline's observer windows) from its own thread, and each turn goes
/// to `ParakeetEngine::transcribe_audio` when it is due, then its label is
/// read with `live_nemotron::label`, as the transcription worker does. One
/// turn at a time: a turn that is due while the previous one still runs
/// waits, as in the worker's queue, and counts as late.
///
/// `dml` and `cpu` set the Labs switch (`parakeet_gpu_enabled.txt` in the
/// test binary's data folder) through the app's own command before the model
/// loads, and `dml` clears it at the end. `npu` loads the product's model on
/// the CPU, then registers the plugin and swaps in an encoder session on the
/// NPU: the CPU sessions (preprocessor, decoder) and Nemotron's DirectML
/// session are built before the plugin is registered, since afterwards the
/// app's `PreferCPU` policy would place CPU sessions on OpenVINO's CPU device
/// (#66).
#[tokio::test]
#[ignore = "NPU probe (#80); inputs from PACED_*, NPU_* and MEASURE_* (scripts/npu-bench/README.md)"]
async fn paced_meeting() -> Result<()> {
    let _ = env_logger::builder().is_test(true).try_init();
    let seconds: f64 = optional("PACED_SECONDS").map_or(Ok(1800.0), |v| v.parse())?;
    let device = optional("PACED_DEVICE").context("PACED_DEVICE is cpu, dml or npu")?;
    let calls_on = optional("PACED_ENGINE").as_deref() != Some("none");
    let audio = existing_path("MEASURE_AUDIO", "a 16 kHz speech file")?;
    let samples = tracks::load(&audio)?.into_iter().next().context("the audio has no track")?.samples;
    let pieces = existing_path("PACED_PIECES", "the kit's parakeet.json for MEASURE_AUDIO")?;
    let turns = turns(&pieces, samples.len(), seconds)?;
    let total = (seconds * 1000.0 * SAMPLES_PER_MS) as usize;
    let looped: std::sync::Arc<Vec<f32>> = std::sync::Arc::new(samples.iter().copied().cycle().take(total).collect());

    let started = (unix_now(), Instant::now());
    let gpu = match device.as_str() {
        "dml" => true,
        "cpu" | "npu" => false,
        other => bail!("PACED_DEVICE {other} is not cpu, dml or npu"),
    };
    crate::parakeet_engine::labs::set_parakeet_gpu_enabled(gpu).await.map_err(anyhow::Error::msg)?;
    let model = existing_path("MEASURE_PARAKEET_MODEL", "the Parakeet model folder")?;
    let engines = Engines::open(None, Some(&model)).await?;
    let parakeet = &engines.parakeet.as_ref().context("no Parakeet engine")?.engine;
    let failures = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let diarization = match optional("MEASURE_DIARIZATION_MODEL") {
        Some(_) => {
            let path = existing_path("MEASURE_DIARIZATION_MODEL", "nemotron3_diar_v3.onnx")?;
            let threshold: f32 = optional("PACED_NEMOTRON_THRESHOLD").map_or(Ok(0.5), |v| v.parse())?;
            let reported = failures.clone();
            let notify = std::sync::Arc::new(move |message: String| {
                log::error!("{message}");
                reported.lock().unwrap().push(message);
            });
            crate::diarization::live_nemotron::start_for_measure(&path, threshold, notify)?;
            true
        }
        None => false,
    };
    let mut frames: Option<usize> = optional("PACED_STATIC_FRAMES").map(|v| v.parse()).transpose()?;
    if device == "npu" {
        let plugin = existing_path("NPU_EP_PLUGIN", "onnxruntime_providers_openvino_plugin.dll")?;
        let environment = crate::onnx_runtime::environment()?;
        environment
            .register_ep_library("OpenVINOExecutionProvider", &plugin)
            .context("registering the OpenVINO plugin EP")?;
        let npu: Vec<_> = environment
            .devices()
            .filter(|d| d.ep().is_ok_and(|ep| ep == "OpenVINOExecutionProvider") && d.hardware_device().ty() == DeviceType::NPU)
            .collect();
        let compile = Instant::now();
        let session = npu_session(environment, npu, &ep_options(), &model.join("encoder-model.int8.onnx"))?;
        println!("NPU encoder session built in {:.0} ms", ms_since(compile));
        frames = Some(optional("NPU_FRAMES").context("NPU_FRAMES: the static shape the NPU compiles")?.parse()?);
        parakeet.replace_encoder(Some(session), frames).await?;
    } else if frames.is_some() {
        parakeet.replace_encoder(None, frames).await?;
    }
    let acceleration = if device == "npu" {
        "NPU encoder (OpenVINO plugin EP)"
    } else {
        engines.parakeet.as_ref().map_or("?", |l| l.acceleration)
    };
    mark("load", started.0, unix_now(), serde_json::json!({ "device": device, "acceleration": acceleration }))?;
    println!(
        "parakeet on {acceleration}, static frames {frames:?}, diarization {diarization}, {} turns over {seconds} s",
        turns.len()
    );

    let t0 = unix_now();
    parakeet.transcribe_audio(looped[..6 * 16_000].to_vec(), None).await?;
    mark("warmup", t0, unix_now(), serde_json::json!({}))?;

    // The remote track, 50 ms at a time on the meeting's clock, from its own
    // thread as the capture pipeline feeds it.
    const WINDOW: usize = 800;
    let start = Instant::now();
    let t0 = unix_now();
    let feeder = diarization.then(|| {
        let audio = looped.clone();
        std::thread::spawn(move || {
            for (i, window) in audio.chunks(WINDOW).enumerate() {
                let due = std::time::Duration::from_secs_f64((i * WINDOW) as f64 / 16_000.0);
                if let Some(wait) = due.checked_sub(start.elapsed()) {
                    std::thread::sleep(wait);
                }
                crate::diarization::live_nemotron::feed((i * WINDOW) as u64, window);
            }
        })
    });

    let mut calls = Vec::with_capacity(turns.len());
    let mut late = 0;
    for turn in turns.iter().filter(|_| calls_on) {
        let due = std::time::Duration::from_secs_f64(turn.due_s);
        match due.checked_sub(start.elapsed()) {
            Some(wait) => tokio::time::sleep(wait).await,
            None => late += 1,
        }
        let began = start.elapsed().as_secs_f64();
        let text = parakeet.transcribe_audio(looped[turn.start..turn.end].to_vec(), None).await?;
        let transcribed = start.elapsed().as_secs_f64();
        let label = if diarization {
            let (from, length) = (turn.start as f64 / 16_000.0, (turn.end - turn.start) as f64 / 16_000.0);
            tokio::task::spawn_blocking(move || crate::diarization::live_nemotron::label(from, length)).await?
        } else {
            None
        };
        let done = start.elapsed().as_secs_f64();
        calls.push(serde_json::json!({
            "due_s": turn.due_s, "start_s": began, "transcribe_ms": (transcribed - began) * 1000.0,
            "label_ms": (done - transcribed) * 1000.0, "lag_s": done - turn.due_s,
            "audio_s": (turn.end - turn.start) as f64 / 16_000.0, "label": label, "text": text,
        }));
    }
    if let Some(wait) = std::time::Duration::from_secs_f64(seconds).checked_sub(start.elapsed()) {
        tokio::time::sleep(wait).await;
    }
    let t1 = unix_now();
    if let Some(feeder) = feeder {
        feeder.join().map_err(|_| anyhow::anyhow!("the feeder thread panicked"))?;
    }
    crate::diarization::live_nemotron::finish();
    crate::diarization::live_nemotron::stop();
    if gpu {
        crate::parakeet_engine::labs::set_parakeet_gpu_enabled(false).await.map_err(anyhow::Error::msg)?;
    }

    let mut latencies: Vec<f64> = calls.iter().filter_map(|c| c["transcribe_ms"].as_f64()).collect();
    latencies.sort_by(f64::total_cmp);
    let pick = |q: f64| latencies.get(((latencies.len() as f64 - 1.0) * q).round() as usize).copied();
    let max_lag = calls.iter().filter_map(|c| c["lag_s"].as_f64()).fold(0.0f64, f64::max);
    let labelled = calls.iter().filter(|c| !c["label"].is_null()).count();
    let failures = failures.lock().unwrap().clone();
    let summary = serde_json::json!({
        "device": device, "acceleration": acceleration, "static_frames": frames, "diarization": diarization,
        "audio_s": seconds, "calls": calls.len(), "late_calls": late, "max_lag_s": max_lag,
        "latency_ms_median": pick(0.5), "latency_ms_p95": pick(0.95), "latency_ms_max": pick(1.0),
        "busy_share": latencies.iter().sum::<f64>() / 1000.0 / seconds, "labelled": labelled,
        "diarization_failures": failures,
    });
    mark("meeting", t0, t1, summary.clone())?;
    if let Some(out) = optional("PACED_OUT") {
        let record = serde_json::json!({ "summary": summary, "calls": calls });
        std::fs::write(out, serde_json::to_string_pretty(&record)?)?;
    }
    println!("meeting: {summary}");
    if !failures.is_empty() {
        bail!("live Nemotron failed: {failures:?}");
    }
    Ok(())
}
