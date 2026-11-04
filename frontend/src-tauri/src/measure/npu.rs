//! Smoke probe for Parakeet's encoder on the Intel NPU through OpenVINO's C API
//! (#66): the device, the first compile and the cached load, and, on the kit's
//! pieces of a recording, the NPU encoder's output against ONNX Runtime's CPU
//! encoder on the same padded input (and the CPU's text without padding).
//!
//! `NPU_TEST_RUNTIME` is a folder with Intel's libraries (the catalog's files
//! plus the NPU plugin and the ONNX frontend), `NPU_TEST_CACHE` the compile
//! cache (empty for a first compile), `MEASURE_PARAKEET_MODEL` the model
//! folder, `MEASURE_AUDIO` the recording, `NPU_TEST_PIECES` how many pieces
//! (default 12, the longest first). With `MEASURE_OUT` it writes `npu-smoke.json`.

use std::path::PathBuf;
use std::time::Instant;

use ndarray::{s, Array1, Array2, Array3, Axis, Ix3};

use super::tracks;
use crate::audio::vad::ContinuousSpeechCap;
use crate::parakeet_engine::model::ParakeetModel;
use crate::parakeet_engine::npu::{openvino::OpenVino, NpuEncoder, FRAMES};

fn folder_bytes(path: &std::path::Path) -> u64 {
    std::fs::read_dir(path)
        .map(|read| {
            read.flatten()
                .map(|item| match item.file_type() {
                    Ok(kind) if kind.is_dir() => folder_bytes(&item.path()),
                    _ => item.metadata().map(|meta| meta.len()).unwrap_or(0),
                })
                .sum()
        })
        .unwrap_or(0)
}

#[test]
#[ignore = "needs NPU_TEST_RUNTIME, NPU_TEST_CACHE, MEASURE_PARAKEET_MODEL, MEASURE_AUDIO and an Intel NPU"]
fn npu_encoder_smoke() {
    let runtime = PathBuf::from(std::env::var_os("NPU_TEST_RUNTIME").expect("NPU_TEST_RUNTIME"));
    let cache = PathBuf::from(std::env::var_os("NPU_TEST_CACHE").expect("NPU_TEST_CACHE"));
    let model_dir = PathBuf::from(std::env::var_os("MEASURE_PARAKEET_MODEL").expect("MEASURE_PARAKEET_MODEL"));
    let audio = PathBuf::from(std::env::var_os("MEASURE_AUDIO").expect("MEASURE_AUDIO"));
    let count: usize = std::env::var("NPU_TEST_PIECES").ok().and_then(|value| value.parse().ok()).unwrap_or(12);
    std::fs::create_dir_all(&cache).unwrap();

    let started = Instant::now();
    let api: &'static OpenVino = Box::leak(Box::new(OpenVino::load(&runtime).expect("load openvino_c.dll")));
    let core = api.core().expect("core");
    let mut device = serde_json::Map::new();
    for key in ["AVAILABLE_DEVICES", "FULL_DEVICE_NAME", "DEVICE_ARCHITECTURE", "NPU_COMPILER_TYPE", "NPU_DRIVER_VERSION", "NPU_COMPILER_VERSION", "DEVICE_GOPS"] {
        let value = core.property("NPU", key);
        println!("NPU {key}: {}", value.as_deref().unwrap_or("-"));
        device.insert(key.to_string(), value.into());
    }
    println!("runtime and NPU plugin loaded in {:.2} s", started.elapsed().as_secs_f64());
    drop(core);

    let encoder_path = model_dir.join("encoder-model.int8.onnx");
    let before = folder_bytes(&cache);
    let started = Instant::now();
    let first = NpuEncoder::compile(api, &encoder_path, Some(&cache)).expect("compile for the NPU");
    let first_s = started.elapsed().as_secs_f64();
    let after = folder_bytes(&cache);
    println!("compile 1: {first_s:.1} s, cache {:.0} -> {:.0} MB", before as f64 / 1e6, after as f64 / 1e6);
    drop(first);
    let started = Instant::now();
    let mut npu = NpuEncoder::compile(api, &encoder_path, Some(&cache)).expect("compile from the cache");
    let cached_s = started.elapsed().as_secs_f64();
    println!("compile 2 (cache): {cached_s:.2} s, cache {:.0} MB", folder_bytes(&cache) as f64 / 1e6);

    let tracks = tracks::load(&audio).expect("read the recording");
    let cut = tracks::cut(&tracks, ContinuousSpeechCap::Streaming).expect("VAD");
    let mut pieces: Vec<_> = cut.pieces.iter().map(|(piece, _)| piece).collect();
    pieces.sort_by(|a, b| b.samples.len().cmp(&a.samples.len()));
    pieces.truncate(count);
    pieces.sort_by(|a, b| a.start_timestamp_ms.total_cmp(&b.start_timestamp_ms));

    let mut cpu = ParakeetModel::new(&model_dir, true).expect("CPU Parakeet");
    let mut rows = Vec::new();
    let mut npu_ms = Vec::new();
    let mut first_call_ms = None;
    for piece in pieces {
        let samples = piece.samples.clone();
        let waveforms = Array2::from_shape_vec((1, samples.len()), samples).unwrap().into_dyn();
        let lens = Array1::from_vec(vec![waveforms.shape()[1] as i64]).into_dyn();
        let (features, feature_lens) = cpu.preprocess(&waveforms.view(), &lens.view()).expect("preprocess");
        let features3 = features.view().into_dimensionality::<Ix3>().unwrap();
        let frames = features3.dim().2;
        assert!(frames <= FRAMES, "{frames} feature frames");
        let length = feature_lens[[0]];

        let started = Instant::now();
        let (on_npu, npu_frames) = npu.encode(&features3, length).expect("NPU encode");
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        if first_call_ms.is_none() {
            first_call_ms = Some(elapsed);
        } else {
            npu_ms.push(elapsed);
        }

        let mut padded = Array3::<f32>::zeros((1, features3.dim().1, FRAMES));
        padded.slice_mut(s![.., .., ..frames]).assign(&features3);
        let (on_cpu_608, cpu_608_lens) = cpu.encode(&padded.view().into_dyn(), &feature_lens.view()).expect("CPU-608 encode");
        let (on_cpu, cpu_lens) = cpu.encode(&features.view(), &feature_lens.view()).expect("CPU encode");
        let cpu_608_frames = cpu_608_lens[[0]] as usize;

        let compared = npu_frames.min(cpu_608_frames);
        let a = on_npu.slice(s![0, ..compared, ..]);
        let b = on_cpu_608.index_axis(Axis(0), 0);
        let b = b.slice(s![..compared, ..]);
        let max_abs = a.iter().zip(b.iter()).map(|(x, y)| (x - y).abs()).fold(0f32, f32::max);
        let mean_abs = a.iter().zip(b.iter()).map(|(x, y)| (x - y).abs() as f64).sum::<f64>() / a.len().max(1) as f64;
        let reference_max = b.iter().map(|x| x.abs()).fold(0f32, f32::max);

        let text_npu = cpu.decode_encoded(&on_npu.view().into_dyn(), npu_frames).expect("decode").text;
        let text_cpu_608 = cpu.decode_encoded(&on_cpu_608.view(), cpu_608_frames).expect("decode").text;
        let text_cpu = cpu.decode_encoded(&on_cpu.view(), cpu_lens[[0]] as usize).expect("decode").text;
        println!(
            "{:7.2}-{:7.2} s, {frames} frames -> {npu_frames}/{cpu_608_frames}: max |NPU - CPU-608| {max_abs:.4} (of {reference_max:.2}), mean {mean_abs:.5}, {elapsed:.0} ms\n  NPU     {text_npu}\n  CPU-608 {text_cpu_608}\n  CPU     {text_cpu}",
            piece.start_timestamp_ms / 1000.0,
            piece.end_timestamp_ms / 1000.0
        );
        rows.push(serde_json::json!({
            "start_ms": piece.start_timestamp_ms, "end_ms": piece.end_timestamp_ms, "frames": frames,
            "npu_frames": npu_frames, "cpu_608_frames": cpu_608_frames, "max_abs": max_abs, "mean_abs": mean_abs,
            "reference_max_abs": reference_max, "npu_ms": elapsed,
            "text_npu": text_npu, "text_cpu_608": text_cpu_608, "text_cpu": text_cpu,
        }));
    }
    npu_ms.sort_by(f64::total_cmp);
    let median = npu_ms.get(npu_ms.len() / 2).copied();
    let same_608 = rows.iter().filter(|row| row["text_npu"] == row["text_cpu_608"]).count();
    let same_cpu = rows.iter().filter(|row| row["text_npu"] == row["text_cpu"]).count();
    println!(
        "first call {:.0} ms, median {:.0} ms; texts NPU = CPU-608 {same_608}/{n}, NPU = CPU {same_cpu}/{n}",
        first_call_ms.unwrap_or_default(),
        median.unwrap_or_default(),
        n = rows.len()
    );
    if let Some(out) = std::env::var_os("MEASURE_OUT").map(PathBuf::from) {
        std::fs::create_dir_all(&out).unwrap();
        let summary = serde_json::json!({
            "device": device, "first_compile_s": first_s, "cached_compile_s": cached_s,
            "cache_bytes": folder_bytes(&cache), "first_call_ms": first_call_ms, "median_call_ms": median,
            "same_text_cpu_608": same_608, "same_text_cpu": same_cpu, "pieces": rows,
        });
        std::fs::write(out.join("npu-smoke.json"), serde_json::to_string_pretty(&summary).unwrap()).unwrap();
    }
}

/// The 16-bit mono samples of a WAV file as #80's `read_wav` reads them
/// (int16 / 32768), so the snap's energies are the same to the bit.
fn read_wav(path: &std::path::Path) -> Vec<f32> {
    let bytes = std::fs::read(path).expect("read the WAV");
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        if &bytes[at..at + 4] == b"data" {
            let data = &bytes[at + 8..(at + 8 + size).min(bytes.len())];
            return data.chunks_exact(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0).collect();
        }
        at += 8 + size + (size & 1);
    }
    panic!("{} has no data chunk", path.display());
}

/// Feed B's port (`parakeet_engine::chunking`) against #80's `chunking.py`
/// on one recording: the windows it plans for the kit's pieces, and the
/// texts its merge and assign give from the words #80 decoded in those
/// windows. `CHUNKING_RUN` is a `parakeet_ort.py` run of feed B
/// (`--chunking overlap --hop-s 3.5 --snap-s 0.5 --retry-words-per-s 0.5`)
/// on `MEASURE_AUDIO` (a 16 kHz mono WAV), kept under `.measure/`: it holds
/// the pieces, each window with its words, the retries and the texts.
#[test]
#[ignore = "needs CHUNKING_RUN and MEASURE_AUDIO (kit fixtures under .measure/)"]
fn chunking_matches_feed_b() {
    use crate::parakeet_engine::chunking::{assign, merge, plan, StretchAudio, Window, Word};
    let run: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(std::env::var_os("CHUNKING_RUN").expect("CHUNKING_RUN")).expect("read the run"),
    )
    .expect("parse the run");
    let samples = read_wav(&PathBuf::from(std::env::var_os("MEASURE_AUDIO").expect("MEASURE_AUDIO")));
    let audio = StretchAudio::borrowed(0.0, &samples);
    let kept: Vec<&serde_json::Value> = run["pieces"].as_array().unwrap().iter().filter(|piece| piece["skipped"].is_null()).collect();
    let pieces: Vec<(f64, f64)> = kept.iter().map(|piece| (piece["start_ms"].as_f64().unwrap(), piece["end_ms"].as_f64().unwrap())).collect();
    let ort = &run["ort"];
    let saved = ort["windows"].as_array().unwrap();
    let retried = ort["retried"].as_array().unwrap();

    // The plan, with each retry that stayed moved back to where it was planned.
    let planned = plan(&pieces, &audio);
    let mut unretried: Vec<(i64, i64, u64)> = Vec::new();
    for window in saved {
        let (mut start, mut end) = (window["start_ms"].as_i64().unwrap(), window["end_ms"].as_i64().unwrap());
        if let Some(retry) = retried.iter().find(|retry| {
            retry["words_after"].as_u64() > retry["words"].as_u64()
                && retry["start_ms"].as_f64().unwrap() + retry["shift_ms"].as_f64().unwrap() == start as f64
        }) {
            let shift = retry["shift_ms"].as_f64().unwrap() as i64;
            (start, end) = (start - shift, end - shift);
        }
        unretried.push((start, end, window["stretch"].as_u64().unwrap()));
    }
    let ours: Vec<(i64, i64, u64)> =
        planned.iter().map(|window| (window.start_ms.round() as i64, window.end_ms.round() as i64, window.stretch as u64)).collect();
    assert_eq!(ours.len(), unretried.len(), "windows planned");
    let differing: Vec<_> = ours.iter().zip(&unretried).enumerate().filter(|(_, (a, b))| a != b).collect();
    assert!(differing.is_empty(), "windows that differ from chunking.py: {differing:?}");

    // The merge and assign over #80's decoded words.
    let windows: Vec<Window> = saved
        .iter()
        .enumerate()
        .map(|(index, window)| Window {
            start_ms: window["start_ms"].as_f64().unwrap(),
            end_ms: window["end_ms"].as_f64().unwrap(),
            stretch: window["stretch"].as_u64().unwrap() as usize,
            first: index == 0 || saved[index - 1]["stretch"] != window["stretch"],
        })
        .collect();
    let decoded: Vec<Vec<Word>> = saved
        .iter()
        .map(|window| {
            window["words"].as_array().unwrap().iter().map(|word| Word::new(word[0].as_f64().unwrap(), word[1].as_str().unwrap())).collect()
        })
        .collect();
    let texts = assign(&pieces, &merge(&windows, &decoded));
    let expected: Vec<String> = kept.iter().map(|piece| piece["rows"].get(0).and_then(|row| row["text"].as_str()).unwrap_or("").to_string()).collect();
    let mut differ = 0;
    for (index, (ours, theirs)) in texts.iter().zip(&expected).enumerate() {
        if ours != theirs {
            differ += 1;
            println!("piece {index} at {:.0} ms:\n  port       {ours}\n  chunking.py {theirs}", pieces[index].0);
        }
    }
    println!("{} pieces, {} windows, {} retries; {differ} texts differ", pieces.len(), windows.len(), retried.len());
    assert_eq!(differ, 0);
}

