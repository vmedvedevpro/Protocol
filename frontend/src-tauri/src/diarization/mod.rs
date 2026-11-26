//! Speaker diarization ("who spoke when") for recorded meetings.
//!
//! Pipeline (all on-device, ONNX Runtime via `ort`):
//!   1. Load the meeting WAV, downmix to mono and resample to 16 kHz.
//!   2. Slide a 10 s window over the audio and run pyannote `segmentation-3.0`,
//!      decoding its 7-class powerset output into per-frame activity for up to
//!      3 *local* speakers within that window.
//!   3. For every local speaker in every window, concatenate its active audio
//!      and extract a WeSpeaker ResNet34 embedding, projected through the VBx
//!      x-vector LDA transform and length-normalized.
//!   4. Cluster all embeddings (agglomerative, cosine) to obtain *global*
//!      speaker identities, then map each local region to its global speaker.
//!   5. Merge adjacent same-speaker regions into final segments.
//!
//! Models live install-locally in `<install>/data/models/diarization`.

pub mod clustering;
pub mod download;
pub mod dsp;
pub mod models;
pub mod nemotron;
pub mod online;
pub mod live_nemotron;
pub mod voiceprint;
pub mod voice_profiles;
pub mod retired;
#[cfg(test)]
mod qualification;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use models::{DiarizationModels, MAX_LOCAL_SPEAKERS};

/// 10 second analysis window (pyannote segmentation-3.0 was trained on 10 s).
const WINDOW_SECONDS: f32 = 10.0;
/// Minimum speech needed to attempt an embedding at all.
const MIN_EMBED_SECONDS: f32 = 0.5;
/// Minimum speech for a turn to be trusted to *define* a speaker cluster.
///
/// Turns shorter than this (typically speech clipped by a window edge) yield
/// noisy embeddings; letting them seed clusters causes speaker over-splitting.
/// They are still labeled — by nearest centroid — just not used to form clusters.
const MIN_CLUSTER_SECONDS: f32 = 1.5;
/// Gap below which two same-speaker segments are merged.
const MERGE_GAP_SECONDS: f32 = 0.5;
/// Default cosine-distance stop threshold for agglomerative clustering.
///
/// Calibrated against real recordings with confirmed speaker counts:
///
/// | recording        | truth | @0.60 |
/// |------------------|-------|-------|
/// | solo presenter   | 1     | 1 ✓   |
/// | team call        | 5     | 5 ✓   |
/// | panel            | 6     | 8     |
/// | interview        | 3     | 2     |
///
/// A single distance threshold cannot satisfy every recording — how far apart
/// two voices land depends on mic, codec and room. 0.60 is the best compromise
/// found, and critically it never invents speakers in single-speaker audio.
/// When the count is known, pass `num_speakers` to bypass the threshold: doing
/// so resolves all of the above exactly.
const DEFAULT_THRESHOLD: f32 = 0.60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizationSegment {
    /// Seconds from the start of the recording.
    pub start: f32,
    pub end: f32,
    /// Global speaker index (0-based). Speaker 0 is reserved for the local
    /// user ("You") when dual-track mic/system files are available.
    pub speaker: usize,
    /// True when another speaker was simultaneously active (overlap).
    #[serde(default)]
    pub overlapped: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiarizationResult {
    pub segments: Vec<DiarizationSegment>,
    pub num_speakers: usize,
    /// Total audio duration in seconds.
    pub duration: f32,
    /// Cluster index identified as the local user, when known.
    #[serde(default)]
    pub user_speaker: Option<usize>,
}

/// Required model files for Pyannote pipeline.
const REQUIRED_FILES: [&str; 3] = [
    models::SEGMENTATION_FILE,
    models::EMBEDDING_FILE,
    models::XVEC_TRANSFORM_FILE,
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiarizationConfig {
    pub engine: String, // "pyannote" or "nemotron"
    pub nemotron_max_speakers: usize,
    pub nemotron_threshold: f32,
    pub pyannote_threshold: f32,
}

impl Default for DiarizationConfig {
    fn default() -> Self {
        Self {
            engine: "pyannote".to_string(),
            nemotron_max_speakers: nemotron::DEFAULT_MAX_SPEAKERS,
            nemotron_threshold: nemotron::DEFAULT_NEMOTRON_THRESHOLD,
            pyannote_threshold: DEFAULT_THRESHOLD,
        }
    }
}

static CONFIG: std::sync::OnceLock<std::sync::RwLock<DiarizationConfig>> = std::sync::OnceLock::new();

fn get_config_lock() -> &'static std::sync::RwLock<DiarizationConfig> {
    CONFIG.get_or_init(|| {
        let path = crate::paths::install_data_root().join("diarization_config.json");
        let cfg = if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|content| serde_json::from_str::<DiarizationConfig>(&content).ok())
                .unwrap_or_default()
        } else {
            DiarizationConfig::default()
        };
        std::sync::RwLock::new(cfg)
    })
}

pub fn get_active_engine() -> String {
    get_config_lock()
        .read()
        .map(|c| c.engine.clone())
        .unwrap_or_else(|_| "pyannote".to_string())
}

pub fn get_diarization_config() -> DiarizationConfig {
    get_config_lock()
        .read()
        .map(|c| c.clone())
        .unwrap_or_default()
}

pub fn save_diarization_config(cfg: &DiarizationConfig) -> Result<()> {
    anyhow::ensure!(matches!(cfg.engine.as_str(), "pyannote" | "nemotron"), "Unknown diarization engine");
    anyhow::ensure!(cfg.nemotron_threshold.is_finite() && (0.1..=0.9).contains(&cfg.nemotron_threshold), "Invalid Nemotron threshold");
    anyhow::ensure!(cfg.pyannote_threshold.is_finite() && (0.1..=0.9).contains(&cfg.pyannote_threshold), "Invalid Pyannote threshold");
    let mut lock = get_config_lock().write().map_err(|_| anyhow!("Diarization settings lock poisoned"))?;
    let path = crate::paths::install_data_root().join("diarization_config.json");
    let json = serde_json::to_string_pretty(cfg)?;
    std::fs::write(path, json)?;
    *lock = cfg.clone();
    Ok(())
}

/// Directory of the models shipped inside the app bundle, resolved once at
/// startup from Tauri's resource directory.
static BUNDLED_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
static OPERATION_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

pub async fn operation_guard() -> tokio::sync::MutexGuard<'static, ()> {
    OPERATION_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

pub fn try_operation_guard() -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    OPERATION_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .try_lock().map_err(|_| "Wait for speaker identification to finish before uninstalling".into())
}

/// Record where the bundled diarization models live (called during setup).
pub fn set_bundled_dir(dir: PathBuf) {
    let _ = BUNDLED_DIR.set(dir);
}

/// True when every required model file exists in `dir`.
fn dir_has_models(dir: &Path) -> bool {
    REQUIRED_FILES.iter().all(|f| dir.join(f).exists())
}

/// Where the app's *writable* diarization model directory is — the target for
/// manual installs and downloads.
pub fn diarization_user_model_dir() -> PathBuf {
    crate::paths::models_dir().join("diarization")
}

/// Resolve the directory the models should actually be loaded from.
///
/// A user-supplied copy in the install-local data folder wins (so models can be
/// swapped or upgraded without rebuilding), otherwise the copy bundled with the
/// app is used. Falls back to the user directory so downloads have a target.
pub fn diarization_model_dir() -> PathBuf {
    let user_dir = diarization_user_model_dir();
    if dir_has_models(&user_dir) {
        return user_dir;
    }
    if let Some(bundled) = BUNDLED_DIR.get() {
        if dir_has_models(bundled) {
            return bundled.clone();
        }
    }
    user_dir
}

/// Whether Pyannote model files are present (bundled or user-supplied).
pub fn pyannote_models_available() -> bool {
    dir_has_models(&diarization_model_dir())
}

/// Whether Nemotron-3 model files are present.
pub fn nemotron_models_available() -> bool {
    let user_dir = diarization_user_model_dir();
    let model_file = user_dir.join(nemotron::NEMOTRON_MODEL_FILENAME);
    model_file.metadata().is_ok_and(|m| m.is_file() && m.len() == nemotron::NEMOTRON_EXPECTED_BYTES)
}

/// Whether models for the specified engine are present.
pub fn models_available_for_engine(engine: &str) -> bool {
    if engine.eq_ignore_ascii_case("nemotron") {
        nemotron_models_available()
    } else {
        pyannote_models_available()
    }
}

/// Whether models for the currently active engine are present.
pub fn models_available() -> bool {
    models_available_for_engine(&get_active_engine())
}

/// One local speaker's activity inside one window.
struct LocalTurn {
    /// Absolute (start, end) regions in seconds.
    regions: Vec<(f32, f32)>,
    /// Absolute regions that overlapped another speaker (subset of `regions`).
    overlapped_regions: Vec<(f32, f32)>,
    /// Concatenated active audio for embedding.
    audio: Vec<f32>,
    /// Total speech duration in seconds (audio.len() / sample_rate).
    speech_secs: f32,
}

/// Run the full diarization pipeline on a WAV file using the active engine.
pub fn diarize_file(
    wav_path: &std::path::Path,
    num_speakers: Option<usize>,
    threshold: Option<f32>,
) -> Result<DiarizationResult> {
    diarize_file_with_engine(wav_path, &get_active_engine(), num_speakers, threshold)
}

/// Run diarization using a specific engine ("pyannote" or "nemotron").
pub fn diarize_file_with_engine(
    wav_path: &std::path::Path,
    engine: &str,
    num_speakers: Option<usize>,
    threshold: Option<f32>,
) -> Result<DiarizationResult> {
    anyhow::ensure!(matches!(engine, "pyannote" | "nemotron"), "Unknown diarization engine");
    if engine == "nemotron" {
        if !nemotron_models_available() {
            return Err(anyhow!(
                "Nemotron-3 diarization model not found in {}. Expected nemotron3_diar_v3.onnx.",
                diarization_user_model_dir().display()
            ));
        }
        let config = get_diarization_config();
        let max_spks = 8;
        let thresh = threshold.unwrap_or(config.nemotron_threshold);
        let model_path = diarization_user_model_dir().join(nemotron::NEMOTRON_MODEL_FILENAME);
        let mut model = nemotron::NemotronDiarizationModel::new(&model_path, max_spks, thresh)?;

        let (samples, sr) = dsp::read_wav(wav_path)?;
        model.diarize(&samples, sr)
    } else {
        let model_dir = diarization_model_dir();
        if !pyannote_models_available() {
            return Err(anyhow!(
                "Pyannote diarization models not found in {}. Expected {}, {} and {}.",
                model_dir.display(),
                models::SEGMENTATION_FILE,
                models::EMBEDDING_FILE,
                models::XVEC_TRANSFORM_FILE
            ));
        }
        diarize_file_with_models(wav_path, &model_dir, num_speakers, threshold)
    }
}

/// Extract just the per-turn speaker embeddings for a recording.
///
/// Exposed for offline evaluation of embedding quality (see the diagnostic in
/// this module's tests) — the clustering step is skipped entirely.
pub fn embeddings_for_debug(wav_path: &Path, model_dir: &Path) -> Result<Vec<Vec<f32>>> {
    let (samples, sr) = dsp::read_wav(wav_path)?;
    let samples = if sr != dsp::SAMPLE_RATE {
        crate::audio::audio_processing::resample_audio(&samples, sr, dsp::SAMPLE_RATE)
    } else {
        samples
    };
    let mut models = DiarizationModels::load(model_dir)?;
    let turns = collect_turns(&mut models, &samples)?;
    let mut out = Vec::new();
    for turn in &turns {
        if turn.speech_secs >= MIN_CLUSTER_SECONDS {
            if let Ok(e) = models.embed(&turn.audio) {
                out.push(e);
            }
        }
    }
    Ok(out)
}

/// Run the pipeline against an explicit model directory.
///
/// Kept separate from [`diarize_file`] so the pipeline can be exercised
/// headlessly (tests / offline evaluation) without a running Tauri app to
/// resolve bundled resource paths.
pub fn diarize_file_with_models(
    wav_path: &std::path::Path,
    model_dir: &Path,
    num_speakers: Option<usize>,
    threshold: Option<f32>,
) -> Result<DiarizationResult> {
    if !wav_path.exists() {
        return Err(anyhow!("Recording not found: {}", wav_path.display()));
    }
    if !dir_has_models(model_dir) {
        return Err(anyhow!(
            "Diarization models not found in {}",
            model_dir.display()
        ));
    }

    // 1. Load + resample to 16 kHz mono.
    let (samples, sr) = dsp::read_wav(wav_path)?;
    let samples = if sr != dsp::SAMPLE_RATE {
        log::info!("ðŸŽšï¸ Diarization: resampling {} Hz â†’ {} Hz", sr, dsp::SAMPLE_RATE);
        crate::audio::audio_processing::resample_audio(&samples, sr, dsp::SAMPLE_RATE)
    } else {
        samples
    };
    let total = samples.len();
    let duration = total as f32 / dsp::SAMPLE_RATE as f32;
    if total == 0 {
        return Ok(DiarizationResult {
            segments: Vec::new(),
            num_speakers: 0,
            duration: 0.0,
            user_speaker: None,
        });
    }
    log::info!("🧑‍🤝‍🧑 Diarization starting: {:.1}s of audio", duration);

    let mut models = DiarizationModels::load(model_dir)?;

    // 2. Slide windows, decode segmentation, collect local turns.
    let turns = collect_turns(&mut models, &samples)?;

    if turns.is_empty() {
        log::info!("🧑‍🤝‍🧑 Diarization: no speech detected");
        return Ok(DiarizationResult {
            segments: Vec::new(),
            num_speakers: 0,
            duration,
            user_speaker: None,
        });
    }

    // 3. Embed each local turn.
    let mut embeddings: Vec<Vec<f32>> = Vec::with_capacity(turns.len());
    let mut kept: Vec<usize> = Vec::with_capacity(turns.len());
    for (i, turn) in turns.iter().enumerate() {
        match models.embed(&turn.audio) {
            Ok(e) => {
                embeddings.push(e);
                kept.push(i);
            }
            Err(e) => log::debug!("Skipping turn {} (embedding failed: {})", i, e),
        }
    }
    if embeddings.is_empty() {
        return Ok(DiarizationResult {
            segments: Vec::new(),
            num_speakers: 0,
            duration,
            user_speaker: None,
        });
    }
    log::info!("🧑‍🤝‍🧑 Diarization: {} turns embedded", embeddings.len());

    // 4. Cluster into global speakers.
    //
    // Only turns with enough speech are allowed to *define* clusters — short
    // fragments (usually speech clipped by a window edge) have noisy embeddings
    // and would otherwise spawn phantom speakers. Every remaining turn is then
    // attached to whichever cluster centroid it most resembles, so nothing
    // loses its label.
    let thresh = threshold.unwrap_or(DEFAULT_THRESHOLD);
    let strong: Vec<usize> = (0..embeddings.len())
        .filter(|&i| turns[kept[i]].speech_secs >= MIN_CLUSTER_SECONDS)
        .collect();

    let labels: Vec<usize> = if strong.len() >= 2 {
        log::info!(
            "🧑‍🤝‍🧑 Clustering on {} reliable turns ({} short turns assigned by similarity)",
            strong.len(),
            embeddings.len() - strong.len()
        );
        let strong_embeddings: Vec<Vec<f32>> =
            strong.iter().map(|&i| embeddings[i].clone()).collect();
        let strong_labels = clustering::agglomerative(&strong_embeddings, num_speakers, thresh);

        let k = strong_labels.iter().copied().max().map(|m| m + 1).unwrap_or(0);
        let dim = embeddings[0].len();

        // Cluster centroids (mean of members, re-normalized).
        let mut centroids = vec![vec![0f32; dim]; k];
        let mut counts = vec![0f32; k];
        for (pos, &i) in strong.iter().enumerate() {
            let c = strong_labels[pos];
            counts[c] += 1.0;
            for d in 0..dim {
                centroids[c][d] += embeddings[i][d];
            }
        }
        for c in 0..k {
            if counts[c] > 0.0 {
                for d in 0..dim {
                    centroids[c][d] /= counts[c];
                }
                let norm = centroids[c].iter().map(|v| v * v).sum::<f32>().sqrt();
                if norm > 1e-8 {
                    for d in 0..dim {
                        centroids[c][d] /= norm;
                    }
                }
            }
        }

        let mut labels = vec![0usize; embeddings.len()];
        for (pos, &i) in strong.iter().enumerate() {
            labels[i] = strong_labels[pos];
        }
        let strong_set: std::collections::HashSet<usize> = strong.iter().copied().collect();
        for i in 0..embeddings.len() {
            if strong_set.contains(&i) {
                continue;
            }
            // Nearest centroid by cosine similarity.
            let mut best = 0usize;
            let mut best_sim = f32::NEG_INFINITY;
            for c in 0..k {
                let sim: f32 = (0..dim).map(|d| embeddings[i][d] * centroids[c][d]).sum();
                if sim > best_sim {
                    best_sim = sim;
                    best = c;
                }
            }
            labels[i] = best;
        }
        labels
    } else {
        // Too little reliable speech to be selective — cluster everything.
        clustering::agglomerative(&embeddings, num_speakers, thresh)
    };

    let num_found = labels.iter().copied().max().map(|m| m + 1).unwrap_or(0);
    // Each cluster's turns and speech, so a log tells a real voice from a
    // cluster of one odd turn (#207).
    let mut cluster_turns = vec![(0usize, 0f32); num_found];
    for (k, &turn_idx) in kept.iter().enumerate() {
        cluster_turns[labels[k]].0 += 1;
        cluster_turns[labels[k]].1 += turns[turn_idx].speech_secs;
    }
    log::info!(
        "🧑‍🤝‍🧑 Clusters (turns, speech): {}",
        cluster_turns
            .iter()
            .enumerate()
            .map(|(c, (n, secs))| format!("Speaker {}: {} turns, {:.1}s", c + 1, n, secs))
            .collect::<Vec<_>>()
            .join("; ")
    );

    // 5. Expand to segments, sort, merge adjacent same-speaker runs.
    // Overlapped regions keep the primary speaker but are flagged.
    let mut segments: Vec<DiarizationSegment> = Vec::new();
    for (k, &turn_idx) in kept.iter().enumerate() {
        let speaker = labels[k];
        let turn = &turns[turn_idx];
        for &(s, e) in &turn.regions {
            let overlapped = turn
                .overlapped_regions
                .iter()
                .any(|&(os, oe)| os < e && oe > s);
            segments.push(DiarizationSegment {
                start: s,
                end: e,
                speaker,
                overlapped,
            });
        }
    }
    segments.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    let mut merged: Vec<DiarizationSegment> = Vec::with_capacity(segments.len());
    for seg in segments {
        if let Some(last) = merged.last_mut() {
            if last.speaker == seg.speaker
                && last.overlapped == seg.overlapped
                && seg.start - last.end <= MERGE_GAP_SECONDS
            {
                if seg.end > last.end {
                    last.end = seg.end;
                }
                continue;
            }
        }
        merged.push(seg);
    }

    // Voiceprint match when available (mixed-file path).
    let user_speaker = {
        let k = num_found;
        if k == 0 {
            None
        } else {
            let dim = embeddings[0].len();
            let mut cents = vec![vec![0f32; dim]; k];
            let mut counts = vec![0f32; k];
            for (i, &lab) in labels.iter().enumerate() {
                if lab >= k {
                    continue;
                }
                counts[lab] += 1.0;
                for d in 0..dim {
                    cents[lab][d] += embeddings[i][d];
                }
            }
            for c in 0..k {
                if counts[c] > 0.0 {
                    for d in 0..dim {
                        cents[c][d] /= counts[c];
                    }
                    let n = cents[c].iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-8);
                    for d in 0..dim {
                        cents[c][d] /= n;
                    }
                }
            }
            voiceprint::match_cluster(&cents)
        }
    };

    log::info!(
        "✅ Diarization complete: {} speakers, {} segments over {:.1}s (user={:?})",
        num_found,
        merged.len(),
        duration,
        user_speaker
    );

    Ok(DiarizationResult {
        segments: merged,
        num_speakers: num_found,
        duration,
        user_speaker,
    })
}

// ============================================================================
// Tauri commands
// ============================================================================

/// Are the diarization models installed?
#[tauri::command]
pub async fn diarization_models_available() -> Result<bool, String> {
    Ok(models_available())
}

/// Status report of the diarization subsystem.
#[derive(Debug, Clone, Serialize)]
pub struct DiarizationEngineStatus {
    pub active_engine: String,
    pub pyannote_available: bool,
    pub nemotron_available: bool,
    pub current_available: bool,
    pub model_dir: String,
    pub nemotron_max_speakers: usize,
    pub nemotron_threshold: f32,
    pub pyannote_threshold: f32,
    pub nemotron_download_size: u64,
    pub pyannote_download_size: u64,
}

#[tauri::command]
pub async fn set_diarization_engine(engine: String) -> Result<(), String> {
    let mut cfg = get_diarization_config();
    cfg.engine = engine.to_lowercase();
    save_diarization_config(&cfg).map_err(|e| e.to_string())?;
    log::info!("🔄 Switched diarization engine to {}", cfg.engine);
    Ok(())
}

#[tauri::command]
pub async fn diarization_get_status() -> Result<DiarizationEngineStatus, String> {
    let cfg = get_diarization_config();
    let py_avail = pyannote_models_available();
    let nemo_avail = nemotron_models_available();
    let current_avail = if cfg.engine.eq_ignore_ascii_case("nemotron") {
        nemo_avail
    } else {
        py_avail
    };

    Ok(DiarizationEngineStatus {
        active_engine: cfg.engine,
        pyannote_available: py_avail,
        nemotron_available: nemo_avail,
        current_available: current_avail,
        model_dir: diarization_user_model_dir().to_string_lossy().to_string(),
        nemotron_max_speakers: cfg.nemotron_max_speakers,
        nemotron_threshold: cfg.nemotron_threshold,
        pyannote_threshold: cfg.pyannote_threshold,
        nemotron_download_size: download::nemotron_download_bytes(),
        pyannote_download_size: download::total_download_bytes(),
    })
}

#[tauri::command]
pub async fn set_diarization_config(
    engine: String,
    nemotron_max_speakers: Option<usize>,
    nemotron_threshold: Option<f32>,
    pyannote_threshold: Option<f32>,
) -> Result<(), String> {
    let mut cfg = get_diarization_config();
    cfg.engine = engine.to_lowercase();
    if let Some(m) = nemotron_max_speakers {
        if !(1..=8).contains(&m) { return Err("Invalid speaker capacity".into()); }
    }
    cfg.nemotron_max_speakers = 8;
    if let Some(t) = nemotron_threshold {
        cfg.nemotron_threshold = t;
    }
    if let Some(t) = pyannote_threshold {
        cfg.pyannote_threshold = t;
    }
    save_diarization_config(&cfg).map_err(|e| e.to_string())?;
    log::info!("💾 Saved diarization config: {:?}", cfg);
    Ok(())
}

#[tauri::command]
pub async fn open_diarization_model_directory() -> Result<(), String> {
    let dir = diarization_user_model_dir();
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// One diarization download at a time.
static DOWNLOAD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Takes the download lock and clears a Cancel left from before, so only a
/// Cancel made during this download stops it.
fn begin_download() -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    let guard = DOWNLOAD_LOCK.try_lock().map_err(|_| "A diarization download is already running".to_string())?;
    download::clear_cancel();
    Ok(guard)
}

/// Download the diarization models: Nemotron's install, or a Pyannote repair.
/// Progress is emitted as `diarization-download-progress` events tagged with
/// the engine. Installing Nemotron does not choose it; the user does (#123).
#[tauri::command]
pub async fn download_diarization_models<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    engine: Option<String>,
) -> Result<(), String> {
    let _busy = crate::updater::busy::hold(crate::updater::busy::BusyReason::ModelDownload);
    let target = engine.unwrap_or_else(get_active_engine);
    let _optional_guard = if target == "nemotron" { Some(crate::optional_models::operation("nemotron")?) } else { None };
    if !matches!(target.as_str(), "pyannote" | "nemotron") { return Err("Unknown diarization engine".into()); }
    let _download_guard = begin_download()?;
    download::download_models_for_engine(&app, &target).await.map_err(|e| {
        let message = e.to_string();
        // The event ends the download's record in every window, which a
        // rejected call alone would not.
        if message == download::CANCELLED {
            download::emit_end(&app, &target, "cancelled", message.clone());
        } else {
            log::error!("Diarization model download failed: {}", message);
            download::emit_end(&app, &target, "error", message.clone());
        }
        message
    })?;
    Ok(())
}

/// Stop a running diarization download; it ends with `download::CANCELLED`.
#[tauri::command]
pub fn cancel_diarization_download() {
    download::request_cancel();
}

/// Rename every transcript segment belonging to one speaker in a meeting.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSpeakerRenameResult {
    pub speaker: String,
    pub count: u64,
    pub removed_name: bool,
    /// `from`'s contact was removed, having no lines left anywhere.
    pub removed_contact: bool,
}

/// `remove_emptied_contact` (the Who said this sheet, after its warning)
/// also removes `from`'s contact when no meeting has its lines any more
/// (PeopleRepository::rename_speaker).
#[tauri::command]
pub async fn rename_meeting_speaker(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    from: String,
    to: String,
    remove_emptied_contact: Option<bool>,
) -> Result<MeetingSpeakerRenameResult, String> {
    use crate::database::repositories::person::{PeopleRepository, RemovedContact};
    let _operation_guard = operation_guard().await;

    let outcome = PeopleRepository::rename_speaker(
        state.db_manager.pool(),
        &meeting_id,
        &from,
        &to,
        remove_emptied_contact.unwrap_or(false),
    )
    .await
    .map_err(|e| format!("Failed to rename speaker: {}", e))?;
    log::info!(
        "🧑‍🤝‍🧑 Renamed speaker '{}' → '{}' across {} segments of meeting {}",
        from, outcome.speaker, outcome.count, meeting_id
    );
    // The voices follow the contacts, as api_merge_people and
    // api_delete_person keep them.
    match &outcome.removed_contact {
        Some(RemovedContact::Merged { source_id, target_id, target_name }) => {
            voice_profiles::contacts_merged(source_id, target_id, target_name)
        }
        Some(RemovedContact::Deleted { person_id }) => voice_profiles::contact_deleted(person_id),
        None => {}
    }
    Ok(MeetingSpeakerRenameResult {
        speaker: outcome.speaker,
        count: outcome.count,
        removed_name: outcome.removed_name,
        removed_contact: outcome.removed_contact.is_some(),
    })
}

/// Move a single transcript line to another speaker. The rest of that label stays put.
#[tauri::command]
pub async fn reassign_transcript_speaker(
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    transcript_id: String,
    to: String,
    from: Option<String>,
) -> Result<MeetingSpeakerRenameResult, String> {
    let _operation_guard = operation_guard().await;
    let outcome = crate::database::repositories::person::PeopleRepository::reassign_transcript_speaker_component(
        state.db_manager.pool(),
        &meeting_id,
        &transcript_id,
        from.as_deref(),
        &to,
    )
    .await
    .map_err(|e| format!("Failed to move this line: {}", e))?;
    Ok(MeetingSpeakerRenameResult {
        speaker: outcome.speaker,
        count: outcome.count,
        removed_name: outcome.removed_name,
        removed_contact: false,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct MeetingDiarizationResult {
    pub num_speakers: usize,
    /// Number of transcript segments that received a speaker label.
    pub labeled: usize,
    /// How many of the `num_speakers` clusters label at least one line;
    /// fewer when a cluster's speech overlaps no line (#207).
    pub speakers_on_lines: usize,
    /// Lines whose label this run changed; 0 when it ended with the labels
    /// the meeting already had (#205).
    pub changed: usize,
    /// Lines that carried a label before this run; with `changed` 0, a run
    /// that repeated the last result, rather than one that labelled nothing.
    pub labelled_before: usize,
    /// (transcript_id, speaker_label) pairs, e.g. ("transcript-â€¦", "Speaker 1").
    pub assignments: Vec<(String, String)>,
}

/// Audio container extensions a meeting recording may use. Recordings are
/// normally written as `audio.mp4`; `.wav` covers imports and older saves.
const AUDIO_EXTS: [&str; 5] = ["mp4", "m4a", "wav", "mp3", "webm"];

fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.iter().any(|a| a.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// Newest audio file directly inside `dir`, if any.
fn newest_audio_in(dir: &Path) -> Option<PathBuf> {
    // Always use the mixed playback file as the meeting anchor. Dedicated
    // mic/system siblings are discovered from its parent by diarize_meeting.
    for name in ["audio.mp4", "audio.m4a", "audio.wav", "audio.mp3", "audio.webm"] {
        let preferred = dir.join(name);
        if preferred.is_file() {
            return Some(preferred);
        }
    }
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_file() && is_audio_file(&path) {
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            found.push((mtime, path));
        }
    }
    found.sort_by_key(|(t, _)| *t);
    found.pop().map(|(_, p)| p)
}

/// The meeting whose recording `find_meeting_audio` looks for in the recordings
/// roots.
struct MeetingAudioLookup<'a> {
    id: &'a str,
    title: &'a str,
    created_at: chrono::DateTime<chrono::Utc>,
}

/// Largest gap between a meeting's `created_at` and the start in a folder name
/// for a folder without a meeting id to count as that meeting's. Meetings saved
/// before v0.2.12 store the save time rather than the start, so a long meeting
/// needs hours; a full day would reach the next occurrence of a daily title.
const MEETING_FOLDER_START_TOLERANCE_SECS: i64 = 12 * 60 * 60;

/// Locate a meeting's recording.
///
/// Recordings are saved per-meeting as
/// `<recordings folder>/<meeting name>_<start>/audio.mp4`, so we search: the
/// meeting's own `folder_path`, then the meeting folders of the recordings roots
/// (see `find_meeting_folder_audio` and `recordings_roots`), then the
/// install-local data root (tray saves).
fn find_meeting_audio(
    folder_path: Option<String>,
    meeting: Option<&MeetingAudioLookup<'_>>,
    recordings_roots: &[PathBuf],
) -> Option<PathBuf> {
    // 1. The meeting's recorded folder (or a direct file path).
    if let Some(folder) = folder_path.as_deref() {
        let p = PathBuf::from(folder);
        if p.is_file() && is_audio_file(&p) {
            return Some(p);
        }
        if p.is_dir() {
            if let Some(found) = newest_audio_in(&p) {
                return Some(found);
            }
        }
    }

    // 2. The meeting folders of the recordings roots.
    if let Some(found) = meeting.and_then(|meeting| find_meeting_folder_audio(meeting, recordings_roots)) {
        return Some(found);
    }

    // 3. Install-local data root (where tray/UI stop-recording saves land).
    newest_audio_in(&crate::paths::install_data_root())
}

/// The meeting's audio in the meeting folders of `recordings_roots`, decided
/// over all roots at once so that their order does not matter.
///
/// A folder whose `metadata.json` carries the meeting's id is the meeting's, and
/// no other folder is guessed even when it has no audio. Without such a folder (the recording
/// saver writes no id, and old folders have no metadata), the result is the
/// folder with the same title, no other meeting's id, and the start closest to
/// `created_at` within `MEETING_FOLDER_START_TOLERANCE_SECS`. Folders whose name
/// is not `<title>_<start>`, such as albums in a broad root, are never used.
fn find_meeting_folder_audio(meeting: &MeetingAudioLookup<'_>, recordings_roots: &[PathBuf]) -> Option<PathBuf> {
    let title = meeting_folder_title_key(meeting.title);
    let mut closest: Option<(i64, PathBuf)> = None;
    for recordings_root in recordings_roots {
        // An unreadable root must not stop the search in the next one.
        let Ok(entries) = std::fs::read_dir(recordings_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some((folder_title, started_at)) = parse_meeting_folder_name(&name) else {
                continue;
            };
            match metadata_meeting_id(&dir) {
                Some(id) if id == meeting.id => return newest_audio_in(&dir),
                Some(_) => continue,
                None => {}
            }
            if meeting_folder_title_key(folder_title) != title {
                continue;
            }
            let distance = (started_at - meeting.created_at).num_seconds().abs();
            if distance > MEETING_FOLDER_START_TOLERANCE_SECS
                || closest.as_ref().is_some_and(|(best, _)| *best <= distance)
            {
                continue;
            }
            if let Some(audio) = newest_audio_in(&dir) {
                closest = Some((distance, audio));
            }
        }
    }
    closest.map(|(_, audio)| audio)
}

/// Split a meeting folder name, `<sanitized title>_<UTC start>`, into the title
/// and the start. The start has been written as `%Y-%m-%d_%H-%M-%S`, then
/// `%Y-%m-%d_%H-%M`, and now `%Y-%m-%d_%H-%M-%S-%3f` with `_<n>` appended on a
/// name collision (see `audio_processing::create_meeting_folder`).
fn parse_meeting_folder_name(name: &str) -> Option<(&str, chrono::DateTime<chrono::Utc>)> {
    let collision_stem = name
        .rsplit_once('_')
        .filter(|(_, n)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        .map(|(stem, _)| stem);
    [Some(name), collision_stem].into_iter().flatten().find_map(|stem| {
        let mut parts = stem.rsplitn(3, '_');
        let (time, date, title) = (parts.next()?, parts.next()?, parts.next()?);
        let start = format!("{}_{}", date, time);
        ["%Y-%m-%d_%H-%M-%S-%3f", "%Y-%m-%d_%H-%M-%S", "%Y-%m-%d_%H-%M"]
            .iter()
            .find_map(|format| chrono::NaiveDateTime::parse_from_str(&start, format).ok())
            .map(|start| (title, start.and_utc()))
    })
}

/// Titles compare the way folder names spell them: sanitized and lowercased.
/// Sanitizing the folder side again also matches folders named before `'` was
/// sanitized.
fn meeting_folder_title_key(title: &str) -> String {
    crate::audio::audio_processing::sanitize_filename(title).to_lowercase()
}

/// The meeting id in a folder's `metadata.json`, if it has one.
fn metadata_meeting_id(dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(dir.join("metadata.json")).ok()?;
    let metadata: serde_json::Value = serde_json::from_str(&raw).ok()?;
    metadata.get("meeting_id")?.as_str().map(str::to_owned)
}

/// Recordings roots to search for a meeting's folder: the folder saved in
/// Settings and the default root, where meetings recorded before the folder was
/// changed still live.
async fn recordings_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = vec![crate::audio::recording_preferences::configured_recordings_folder(app).await];
    let default_root = crate::audio::recording_preferences::get_default_recordings_folder();
    if !roots.contains(&default_root) {
        roots.push(default_root);
    }
    roots
}

fn is_manual_speaker_label(label: &str) -> bool {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return false;
    }
    let is_generated = trimmed.split(" + ").all(|part| {
        let p = part.trim();
        p.eq_ignore_ascii_case("guest")
            || p.eq_ignore_ascii_case("you")
            || p.eq_ignore_ascii_case("unknown")
            || (p.to_ascii_lowercase().starts_with("speaker ")
                && p[8..].trim().chars().all(|c| c.is_ascii_digit()))
    });
    !is_generated
}

fn extract_manual_speaker_names(label: &str) -> Vec<String> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let mut names = Vec::new();
    for part in trimmed.split(" + ") {
        let p = part.trim();
        if !p.is_empty()
            && !p.eq_ignore_ascii_case("guest")
            && !p.eq_ignore_ascii_case("you")
            && !p.eq_ignore_ascii_case("unknown")
            && !(p.to_ascii_lowercase().starts_with("speaker ")
                && p[8..].trim().chars().all(|c| c.is_ascii_digit()))
        {
            names.push(p.to_string());
        }
    }
    names
}

/// Whether the mic track's turns are one voice, so that they may update the
/// user's voiceprint: three turns at least, and one cluster under the
/// default threshold with none folded in. The automatic clustering folds a
/// one-turn cluster into the main voice (#217); here that turn would be
/// another voice, laughter or noise on the mic, and its embedding would go
/// into the voiceprint, so the guard reads the clusters before folding.
fn mic_is_one_consistent_voice(embeddings: &[Vec<f32>]) -> bool {
    embeddings.len() >= 3
        && clustering::agglomerative_unfolded(embeddings, DEFAULT_THRESHOLD)
            .iter()
            .all(|&label| label == 0)
}

/// Decode any supported audio container to a temporary 16 kHz mono WAV using
/// the bundled ffmpeg. Returns the original path unchanged if it's already WAV.
fn ensure_wav(path: &Path) -> Result<(PathBuf, bool)> {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("wav"))
        .unwrap_or(false)
    {
        return Ok((path.to_path_buf(), false));
    }

    let ffmpeg = crate::audio::ffmpeg::find_ffmpeg_path()
        .ok_or_else(|| anyhow!("ffmpeg not found — cannot decode {}", path.display()))?;

    static TEMP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let out = std::env::temp_dir().join(format!(
        "meetily-diarize-{}-{}-{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        TEMP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));

    log::info!("🎞️ Decoding {} → 16 kHz mono WAV for diarization", path.display());
    let mut cmd = std::process::Command::new(&ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i",
    ])
    .arg(path)
    .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
    .arg(&out);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let status = cmd
        .status()
        .map_err(|e| anyhow!("Failed to run ffmpeg: {}", e))?;
    if !status.success() || !out.exists() {
        let _ = std::fs::remove_file(&out);
        return Err(anyhow!("ffmpeg failed to decode {}", path.display()));
    }
    Ok((out, true))
}

/// Diarize a meeting's recording and assign "Speaker N" labels to its transcript segments.
#[tauri::command]
pub async fn diarize_meeting(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::state::AppState>,
    meeting_id: String,
    audio_path: Option<String>,
    num_speakers: Option<usize>,
    threshold: Option<f32>,
    engine: Option<String>,
) -> Result<MeetingDiarizationResult, String> {
    let _busy = crate::updater::busy::hold(crate::updater::busy::BusyReason::Diarization);
    let _operation_guard = operation_guard().await;
    let pool = state.db_manager.pool();
    let selected_engine = engine.unwrap_or_else(get_active_engine);
    if !matches!(selected_engine.as_str(), "pyannote" | "nemotron") { return Err("Unknown diarization engine".into()); }
    // Counts saved by older UI versions must not silently switch the engine.
    let num_speakers = if selected_engine == "nemotron" { None } else { num_speakers };

    // Resolve the recording.
    let meeting: Option<(Option<String>, String, chrono::DateTime<chrono::Utc>)> =
        sqlx::query_as("SELECT folder_path, title, created_at FROM meetings WHERE id = ?")
            .bind(&meeting_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("Failed to read meeting: {}", e))?;

    let (folder_path, lookup) = match &meeting {
        Some((folder, title, created_at)) => (
            folder.clone(),
            Some(MeetingAudioLookup { id: &meeting_id, title, created_at: *created_at }),
        ),
        None => (None, None),
    };

    let source = match audio_path {
        Some(p) => PathBuf::from(p),
        None => {
            let roots = recordings_roots(&app).await;
            find_meeting_audio(folder_path.clone(), lookup.as_ref(), &roots).ok_or_else(|| {
                let searched: Vec<String> = roots.iter().map(|root| root.display().to_string()).collect();
                format!(
                    "No recording found for this meeting. Looked in the meeting folder, \
                     {} and the app data folder.",
                    searched.join(", ")
                )
            })?
        }
    };
    log::info!("🧑‍🤝‍🧑 Diarizing meeting {} with {} using {}", meeting_id, selected_engine, source.display());

    let voiceprint_source = meeting_id.clone();
    let engine_for_blocking = selected_engine.clone();
    let (result, used_source_tracks, profile_names) = tokio::task::spawn_blocking(move || -> Result<(DiarizationResult, bool, std::collections::HashMap<usize, String>)> {
        let parent = source.parent().map(Path::to_path_buf);
        let mic_source = parent.as_ref().map(|p| p.join("mic.mp4"));
        let system_source = parent.as_ref().map(|p| p.join("system.mp4"));

        if let (Some(mic), Some(system)) = (mic_source, system_source) {
            if mic.exists() && system.exists() {
                log::info!(
                    "Using separate diarization tracks: mic={} system={}",
                    mic.display(),
                    system.display()
                );
                let (mic_wav, mic_temp) = ensure_wav(&mic)?;
                let (system_wav, system_temp) = match ensure_wav(&system) {
                    Ok(decoded) => decoded,
                    Err(error) => {
                        if mic_temp {
                            let _ = std::fs::remove_file(&mic_wav);
                        }
                        return Err(error);
                    }
                };

                let dual_result = (|| -> Result<DiarizationResult> {
                    if engine_for_blocking.eq_ignore_ascii_case("nemotron") {
                        let config = get_diarization_config();
                        let model_path = diarization_user_model_dir().join(nemotron::NEMOTRON_MODEL_FILENAME);
                        let engine = TrackEngine::Nemotron { model: &model_path, config: &config };
                        return diarize_track_wavs(engine, &mic_wav, &system_wav, num_speakers, threshold);
                    }

                    // Pyannote dual track path
                    let model_dir = diarization_model_dir();
                    let mic_embeddings = embeddings_for_debug(&mic_wav, &model_dir).ok();

                    let engine = TrackEngine::Pyannote { models: &model_dir };
                    let result = diarize_track_wavs(engine, &mic_wav, &system_wav, num_speakers, threshold)?;
                    if let Some(embeddings) = mic_embeddings {
                        if mic_is_one_consistent_voice(&embeddings) {
                            if let Err(error) = voiceprint::update_from_embeddings(
                                &embeddings,
                                &voiceprint_source,
                            ) {
                                log::warn!("Could not update user voiceprint: {error}");
                            }
                        } else {
                            log::info!(
                                "Skipping voiceprint enrollment: mic track was not one consistent voice"
                            );
                        }
                    }

                    Ok(result)
                })();

                let profile_names = match &dual_result {
                    Ok(result) => match voice_profiles::match_offline_speakers(&system_wav, &result.segments.iter()
                        .filter(|segment| segment.speaker != 0).cloned().collect::<Vec<_>>()) {
                        Ok(names) => names,
                        Err(error) => {
                            log::warn!("Named voice matching unavailable for offline diarization: {error}");
                            std::collections::HashMap::new()
                        }
                    },
                    Err(_) => std::collections::HashMap::new(),
                };
                if mic_temp {
                    let _ = std::fs::remove_file(&mic_wav);
                }
                if system_temp {
                    let _ = std::fs::remove_file(&system_wav);
                }
                return dual_result.map(|result| (result, true, profile_names));
            }
        }

        let (wav, is_temp) = ensure_wav(&source)?;
        let out = diarize_file_with_engine(&wav, &engine_for_blocking, num_speakers, threshold);
        if is_temp {
            let _ = std::fs::remove_file(&wav);
        }
        out.map(|result| (result, false, std::collections::HashMap::new()))
    })
    .await
    .map_err(|e| format!("Diarization task failed: {}", e))?
    .map_err(|e| e.to_string())?;

    // Load transcript segments with their recording-relative timings, plus the
    // label each already carries and whether the user placed it by hand.
    let rows: Vec<LabelRow> = sqlx::query_as::<_, (String, Option<f64>, Option<f64>, Option<String>, bool)>(
        "SELECT id, audio_start_time, audio_end_time, speaker, speaker_manual FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time ASC, id ASC",
    )
    .bind(&meeting_id)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Failed to read transcripts: {}", e))?
    .into_iter()
    .map(|(id, start, end, speaker, hand_placed)| LabelRow { id, start, end, speaker, hand_placed })
    .collect();

    // Names the user gave speakers (on transcript lines, or linked contacts)
    // are matched to the new voice clusters, so a rerun carries each name to
    // the rest of that person's lines instead of falling back to "Speaker N".
    let registered_speakers: Vec<String> = sqlx::query_scalar(
        "SELECT speaker_label FROM person_speakers WHERE meeting_id = ?",
    )
    .bind(&meeting_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    let LabelPlan {
        updates,
        assignments,
        kept,
        cluster_to_manual_name,
        changed,
        speakers_on_lines,
        labelled_before,
        lines_per_label,
    } = plan_labels(
        &rows,
        &result,
        &profile_names,
        &registered_speakers,
        used_source_tracks,
        num_speakers,
    );
    log::info!("🧑‍🤝‍🧑 Lines per label: {:?}", lines_per_label);
    if speakers_on_lines < result.num_speakers {
        log::warn!(
            "🧑‍🤝‍🧑 {} speaker(s) found, but only {} label lines: the others overlap no line",
            result.num_speakers,
            speakers_on_lines
        );
    }
    persist_speaker_labels(pool, &meeting_id, updates).await.map_err(|e| format!("Failed to save speaker labels: {e}"))?;

    // Link contacts whose saved voice profile named a cluster in this meeting.
    // The labels are already saved, so a voice whose contact is gone is
    // skipped and a failed link never fails the rerun.
    let used_names: std::collections::HashSet<&str> = assignments.iter().map(|(_, label)| label.as_str()).collect();
    for (name, person_id) in voice_profiles::active_person_links() {
        if !used_names.contains(name.as_str()) {
            continue;
        }
        if let Err(error) = sqlx::query(
            "INSERT OR IGNORE INTO person_speakers (person_id, meeting_id, speaker_label) \
             SELECT id, ?, ? FROM people WHERE id = ?",
        )
        .bind(&meeting_id)
        .bind(&name)
        .bind(&person_id)
        .execute(pool)
        .await
        {
            log::warn!("Could not link a matched voice to its contact: {error}");
        }
    }

    // Keep contacts linked to the names the rerun carried forward.
    if !cluster_to_manual_name.is_empty() {
        let mut person_tx = pool
            .begin()
            .await
            .map_err(|e| format!("Failed to begin person reconciliation: {e}"))?;
        for manual_name in cluster_to_manual_name.values() {
            if crate::database::repositories::person::is_person_name(manual_name) {
                let _ = crate::database::repositories::person::PeopleRepository::reconcile_speaker_identity(
                    &mut person_tx,
                    &meeting_id,
                    manual_name,
                    manual_name,
                )
                .await;
            }
        }
        let _ = person_tx.commit().await;
    }

    // Mirror the new labels into the meeting folder's transcripts.json.
    if let Some(ref folder) = folder_path {
        let p = PathBuf::from(folder);
        if p.is_dir() {
            if let Ok(db_transcripts) = sqlx::query_as::<_, (String, String, String, Option<f64>, Option<f64>, Option<f64>, Option<String>)>(
                "SELECT id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker FROM transcripts WHERE meeting_id = ? ORDER BY audio_start_time ASC"
            )
            .bind(&meeting_id)
            .fetch_all(pool)
            .await
            {
                let segments_to_write: Vec<crate::api::TranscriptSegment> = db_transcripts
                    .into_iter()
                    .map(|(tid, text, ts, s, e, d, spk)| crate::api::TranscriptSegment {
                        id: tid,
                        text,
                        timestamp: ts,
                        audio_start_time: s,
                        audio_end_time: e,
                        duration: d,
                        speaker: spk,
                    })
                    .collect();
                let _ = crate::audio::common::write_transcripts_json(&p, &segments_to_write);
            }
        }
    }
    if kept > 0 {
        log::info!(
            "🧑‍🤝‍🧑 Kept {} existing speaker label(s): placed by hand, or no voice overlap",
            kept
        );
    }

    log::info!(
        "âœ… Meeting {} diarized: {} speakers, {} segments labeled",
        meeting_id,
        result.num_speakers,
        assignments.len()
    );

    Ok(MeetingDiarizationResult {
        num_speakers: result.num_speakers,
        labeled: assignments.len(),
        speakers_on_lines,
        changed,
        labelled_before,
        assignments,
    })
}

/// The engine [`diarize_track_wavs`] runs, with its model.
pub(crate) enum TrackEngine<'a> {
    /// The `.onnx` file; its speaker limit and threshold come from `config`
    /// unless the caller gives them.
    Nemotron { model: &'a Path, config: &'a DiarizationConfig },
    /// The folder with the Pyannote models.
    Pyannote { models: &'a Path },
}

/// The timeline of a recording with separate tracks, from a WAV of each:
/// Nemotron runs one model over both and resets its streaming state in
/// between; Pyannote is told the microphone has one speaker and the system
/// track `num_speakers - 1`; with `num_speakers` one, the system track is not
/// diarized. Then [`merge_tracks`]. `diarize_meeting` calls it, and so does
/// the measurement kit (`crate::measure`), so that the kit's speaker numbers
/// are the app's.
pub(crate) fn diarize_track_wavs(
    engine: TrackEngine,
    mic_wav: &Path,
    system_wav: &Path,
    num_speakers: Option<usize>,
    threshold: Option<f32>,
) -> Result<DiarizationResult> {
    let remote_count = num_speakers.map(|k| k.saturating_sub(1).max(1));
    let no_system_speakers = |mic: &DiarizationResult| DiarizationResult {
        segments: Vec::new(),
        num_speakers: 0,
        duration: mic.duration,
        user_speaker: None,
    };

    match engine {
        TrackEngine::Nemotron { model, config } => {
            let max_spks = num_speakers.unwrap_or(config.nemotron_max_speakers);
            let thresh = threshold.unwrap_or(config.nemotron_threshold);
            let mut nemotron_model = nemotron::NemotronDiarizationModel::new(model, max_spks, thresh)?;

            let (mic_samples, mic_sr) = dsp::read_wav(mic_wav)?;
            let mic_result = nemotron_model.diarize(&mic_samples, mic_sr)?;

            nemotron_model.reset_streaming_state();
            let system_result = if num_speakers == Some(1) {
                no_system_speakers(&mic_result)
            } else {
                let (sys_samples, sys_sr) = dsp::read_wav(system_wav)?;
                nemotron_model.diarize(&sys_samples, sys_sr)?
            };
            Ok(merge_tracks(mic_result, system_result))
        }
        TrackEngine::Pyannote { models } => {
            let mic_result = diarize_file_with_models(mic_wav, models, Some(1), threshold)?;
            let system_result = if num_speakers == Some(1) {
                no_system_speakers(&mic_result)
            } else {
                diarize_file_with_models(system_wav, models, remote_count, threshold)?
            };
            Ok(merge_tracks(mic_result, system_result))
        }
    }
}

/// The timeline of a recording with separate tracks: all the microphone's
/// speech is the user (speaker 0) and the system track's speakers follow from
/// 1, in start order. A turn that overlaps another speaker's is marked
/// overlapped; across the tracks that is local and remote speech at once.
fn merge_tracks(mic: DiarizationResult, system: DiarizationResult) -> DiarizationResult {
    let num_speakers = 1 + system.num_speakers;
    let duration = mic.duration.max(system.duration);
    let mut segments: Vec<DiarizationSegment> = mic
        .segments
        .into_iter()
        .map(|mut s| {
            s.speaker = 0;
            s
        })
        .collect();
    segments.extend(system.segments.into_iter().map(|mut s| {
        s.speaker += 1;
        s
    }));
    segments.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    let snapshot = segments.clone();
    for seg in &mut segments {
        if snapshot
            .iter()
            .any(|other| other.speaker != seg.speaker && other.start < seg.end && other.end > seg.start)
        {
            seg.overlapped = true;
        }
    }
    DiarizationResult { segments, num_speakers, duration, user_speaker: Some(0) }
}

/// The diarized speakers of the transcript row from `s` to `e` (seconds),
/// the one who overlaps it most first, then each other speaker who overlaps
/// it for at least a fifth of that (and 80 ms) and talks at the same time as
/// the first for 80 ms inside it, in speaker order. Of speakers who overlap it
/// equally, the lower index comes first, so a row's speakers do not change
/// between runs. Empty when no diarized speech overlaps the row. pub(crate)
/// for the measurement kit (`crate::measure`), which labels rows as
/// `diarize_meeting` does.
pub(crate) fn row_speakers(segments: &[DiarizationSegment], s: f32, e: f32) -> Vec<usize> {
    let relevant_segments: Vec<&DiarizationSegment> = segments
        .iter()
        .filter(|seg| {
            let ov = seg.end.min(e) - seg.start.max(s);
            ov > 0.0
        })
        .collect();

    let mut overlap_by_speaker: std::collections::BTreeMap<usize, f32> =
        std::collections::BTreeMap::new();
    for seg in &relevant_segments {
        let ov = seg.end.min(e) - seg.start.max(s);
        if ov > 0.0 {
            *overlap_by_speaker.entry(seg.speaker).or_insert(0.0) += ov;
        }
    }

    // `max_by` keeps the last of equal maxima; the reversed index makes it the lowest.
    let Some((&primary, _)) = overlap_by_speaker.iter().max_by(|a, b| {
        a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| b.0.cmp(a.0))
    }) else {
        return Vec::new();
    };
    let cutoff = (overlap_by_speaker[&primary] * 0.20).max(0.08);
    let mut speakers = vec![primary];
    for (&other, &other_ov) in &overlap_by_speaker {
        if other != primary && other_ov >= cutoff {
            let has_simultaneous = relevant_segments.iter().any(|a| {
                a.speaker == primary
                    && relevant_segments.iter().any(|b| {
                        b.speaker == other
                            && a.end.min(b.end).min(e) - a.start.max(b.start).max(s)
                                >= 0.08
                    })
            });
            if has_simultaneous {
                speakers.push(other);
            }
        }
    }
    speakers
}

/// A transcript row as a rerun of speaker identification reads it.
#[derive(Debug, Clone)]
pub(crate) struct LabelRow {
    pub id: String,
    /// Seconds within the recording.
    pub start: Option<f64>,
    pub end: Option<f64>,
    /// The label it carries now.
    pub speaker: Option<String>,
    /// The user moved this line to its speaker on its own (`speaker_manual`).
    pub hand_placed: bool,
}

/// What a rerun writes, and what it found.
#[derive(Debug, Default)]
pub(crate) struct LabelPlan {
    /// New labels; a row absent here keeps its label.
    pub updates: Vec<(String, Option<String>)>,
    /// Every row's label after the rerun.
    pub assignments: Vec<(String, String)>,
    /// Rows that kept their label: placed by hand, or with no voice over them.
    pub kept: u32,
    /// Voice cluster -> the name the user gave it.
    pub cluster_to_manual_name: std::collections::HashMap<usize, String>,
    /// Rows whose label is not the one they had.
    pub changed: usize,
    /// Clusters whose label is on at least one row, counted after the
    /// source-track hint, which can push a cluster off a row.
    pub speakers_on_lines: usize,
    /// Rows that carried a label before the rerun.
    pub labelled_before: usize,
    /// Rows per label component ("Speaker 1", "Anna", "You").
    pub lines_per_label: std::collections::BTreeMap<String, usize>,
}

/// The labels a diarization `result` gives the meeting's `rows` (#217).
///
/// A name the user gave belongs to a voice, not to the lines it sat on:
/// every row is labelled from the new clusters, each given name goes to the
/// cluster whose speech overlaps its lines most (one name per cluster), and
/// the rows of a cluster no name matched get a generated label, even if they
/// carried a name before. A row the user moved by hand on its own keeps its
/// label. With a chosen count, a cluster that leads no row is added to the
/// row it covers the largest part of, so the meeting shows every chosen
/// speaker that has speech over a line.
pub(crate) fn plan_labels(
    rows: &[LabelRow],
    result: &DiarizationResult,
    profile_names: &std::collections::HashMap<usize, String>,
    registered_speakers: &[String],
    used_source_tracks: bool,
    num_speakers: Option<usize>,
) -> LabelPlan {
    use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
    let timing = |row: &LabelRow| match (row.start, row.end) {
        (Some(s), Some(e)) if e > s => Some((s as f32, e as f32)),
        _ => None,
    };

    // Work out which of the freshly-clustered speakers is the local user.
    let user_ranges: Vec<(f32, f32)> = rows
        .iter()
        .filter(|row| row.speaker.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("you")))
        .filter_map(timing)
        .collect();
    let user_speaker: Option<usize> = if result.user_speaker.is_some() {
        result.user_speaker
    } else if user_ranges.is_empty() {
        None
    } else {
        let mut overlap_per_speaker: HashMap<usize, f32> = HashMap::new();
        for seg in &result.segments {
            for (us, ue) in &user_ranges {
                let ov = seg.end.min(*ue) - seg.start.max(*us);
                if ov > 0.0 {
                    *overlap_per_speaker.entry(seg.speaker).or_insert(0.0) += ov;
                }
            }
        }
        overlap_per_speaker
            .into_iter()
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| b.0.cmp(&a.0)))
            .map(|(spk, _)| spk)
    };
    if let Some(u) = user_speaker {
        log::info!("🧑‍🤝‍🧑 Speaker {} identified as the local user", u + 1);
    }

    let mut manual_speakers_ranges: BTreeMap<String, Vec<(f32, f32)>> = BTreeMap::new();
    for row in rows {
        if let (Some(range), Some(spk)) = (timing(row), &row.speaker) {
            for name in extract_manual_speaker_names(spk) {
                manual_speakers_ranges.entry(name).or_default().push(range);
            }
        }
    }
    for label in registered_speakers {
        if is_manual_speaker_label(label) {
            manual_speakers_ranges.entry(label.clone()).or_default();
        }
    }

    // Voice cluster index -> manual name (cluster 1 -> "Alice").
    let mut cluster_to_manual_name: HashMap<usize, String> = HashMap::new();
    if !manual_speakers_ranges.is_empty() {
        let mut cluster_overlaps: Vec<(usize, String, f32)> = Vec::new();
        for spk in 0..result.num_speakers {
            if Some(spk) == user_speaker {
                continue;
            }
            for (name, ranges) in &manual_speakers_ranges {
                let mut total_overlap = 0.0f32;
                for seg in result.segments.iter().filter(|seg| seg.speaker == spk) {
                    for (rs, re) in ranges {
                        let ov = seg.end.min(*re) - seg.start.max(*rs);
                        if ov > 0.0 {
                            total_overlap += ov;
                        }
                    }
                }
                if total_overlap > 0.05 {
                    cluster_overlaps.push((spk, name.clone(), total_overlap));
                }
            }
        }
        cluster_overlaps.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

        // Pair clusters and names one-to-one, strongest overlap first.
        let mut assigned_clusters = HashSet::new();
        let mut assigned_names = HashSet::new();
        for (spk, name, _) in &cluster_overlaps {
            if !assigned_clusters.contains(spk) && !assigned_names.contains(name) {
                cluster_to_manual_name.insert(*spk, name.clone());
                assigned_clusters.insert(*spk);
                assigned_names.insert(name.clone());
            }
        }
        log::info!("🧑‍🤝‍🧑 Matched voice clusters to manual speaker names: {:?}", cluster_to_manual_name);
    }

    let speaker_label = |spk: usize| -> String {
        if Some(spk) == user_speaker {
            return "You".to_string();
        }
        // A name the user gave in this meeting wins over a voice-profile guess.
        if let Some(manual_name) = cluster_to_manual_name.get(&spk) {
            return manual_name.clone();
        }
        if let Some(name) = profile_names.get(&spk) {
            return name.clone();
        }
        let display = match user_speaker {
            Some(user) if spk > user => spk,
            _ => spk + 1,
        };
        format!("Speaker {}", display)
    };

    // The clusters over each row the rerun labels; None for a row it keeps
    // or clears.
    let relabelled = |row: &LabelRow| !(row.hand_placed && row.speaker.as_deref().is_some_and(|s| !s.trim().is_empty()));
    let mut row_clusters: Vec<Option<Vec<usize>>> = rows
        .iter()
        .map(|row| match timing(row) {
            Some((s, e)) if relabelled(row) => Some(row_speakers(&result.segments, s, e)),
            _ => None,
        })
        .collect();

    // A chosen count is a promise (#207): a cluster that leads no row joins
    // the row it covers the largest part of.
    if num_speakers.is_some() {
        let on_rows: BTreeSet<usize> = row_clusters.iter().flatten().flatten().copied().collect();
        for spk in (0..result.num_speakers).filter(|spk| !on_rows.contains(spk)) {
            let best = rows
                .iter()
                .enumerate()
                .filter(|(i, _)| row_clusters[*i].as_ref().is_some_and(|c| !c.is_empty()))
                .filter_map(|(i, row)| {
                    let (s, e) = timing(row)?;
                    let covered: f32 = result
                        .segments
                        .iter()
                        .filter(|seg| seg.speaker == spk)
                        .map(|seg| (seg.end.min(e) - seg.start.max(s)).max(0.0))
                        .sum();
                    (covered > 0.0).then_some((i, covered / (e - s)))
                })
                .max_by(|a, b| a.1.total_cmp(&b.1).then_with(|| b.0.cmp(&a.0)));
            if let Some((i, share)) = best {
                log::info!("🧑‍🤝‍🧑 Speaker {} leads no line; added to the line it covers most ({:.0}%)", spk + 1, share * 100.0);
                row_clusters[i].as_mut().expect("filtered on Some").push(spk);
            }
        }
    }

    let mut plan = LabelPlan::default();
    let mut clusters_on_lines: BTreeSet<usize> = BTreeSet::new();
    for (row, clusters) in rows.iter().zip(row_clusters) {
        let existing = row.speaker.as_deref().map(str::trim).filter(|label| !label.is_empty());
        plan.labelled_before += usize::from(existing.is_some());
        if !relabelled(row) {
            // Placed by hand: it keeps its label and is not written.
            let label = existing.unwrap_or_default();
            plan.kept += 1;
            plan.assignments.push((row.id.clone(), label.to_string()));
            for part in label.split(" + ") {
                *plan.lines_per_label.entry(part.trim().to_string()).or_default() += 1;
            }
            continue;
        }
        let label: Option<String> = match clusters {
            // A row without a usable duration overlaps no voice. A name the
            // user gave stays, as on a row no voice overlaps; a generated
            // label ("Speaker N", "You") says nothing the new clusters back,
            // so it is cleared.
            None => {
                let name = existing.filter(|label| is_manual_speaker_label(label)).map(str::to_string);
                if name.is_some() {
                    plan.kept += 1;
                }
                name
            }
            // Generated labels are not durable capture-source provenance.
            // Preserve source hints without excluding genuine simultaneous
            // speakers. Diarization updates labels only: text length cannot
            // establish word alignment, and reruns must preserve every
            // transcript byte and timing.
            Some(mut speakers) if !speakers.is_empty() => {
                speakers.sort_unstable();
                speakers.dedup();
                let mut labels: Vec<_> = speakers.iter().copied().map(&speaker_label).collect();
                apply_source_track_hint(row.speaker.as_deref(), used_source_tracks, num_speakers != Some(1), &mut labels);
                labels.dedup();
                labels.truncate(3);
                // The hint can put "You" first and the cap then drops a
                // cluster, so a cluster counts only when its label stayed.
                clusters_on_lines.extend(speakers.into_iter().filter(|&spk| labels.contains(&speaker_label(spk))));
                Some(labels.join(" + "))
            }
            Some(_) => {
                // No voice overlaps this line: keep the source hint, or else
                // the label it already had, rather than clearing it.
                let mut labels = Vec::new();
                apply_source_track_hint(row.speaker.as_deref(), used_source_tracks, num_speakers != Some(1), &mut labels);
                let fallback = (!labels.is_empty()).then(|| labels.join(" + ")).or_else(|| existing.map(str::to_string));
                if fallback.is_some() {
                    plan.kept += 1;
                }
                fallback
            }
        };
        if label.as_deref() != existing {
            plan.changed += 1;
        }
        if let Some(label) = &label {
            plan.assignments.push((row.id.clone(), label.clone()));
            for part in label.split(" + ") {
                *plan.lines_per_label.entry(part.trim().to_string()).or_default() += 1;
            }
        }
        plan.updates.push((row.id.clone(), label));
    }
    plan.speakers_on_lines = clusters_on_lines.len();
    plan.cluster_to_manual_name = cluster_to_manual_name;
    plan
}

async fn persist_speaker_labels(
    pool: &sqlx::SqlitePool,
    meeting_id: &str,
    updates: Vec<(String, Option<String>)>,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    for (id, label) in updates {
        sqlx::query("UPDATE transcripts SET speaker = ? WHERE id = ? AND meeting_id = ?")
            .bind(label).bind(id).bind(meeting_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Slide the analysis window over samples, decode segmentation and
/// collect one [LocalTurn] per local speaker per window.
fn collect_turns(models: &mut DiarizationModels, samples: &[f32]) -> Result<Vec<LocalTurn>> {
    let total = samples.len();
    let duration = total as f32 / dsp::SAMPLE_RATE as f32;
    let window_len = (WINDOW_SECONDS * dsp::SAMPLE_RATE as f32) as usize;
    let mut turns: Vec<LocalTurn> = Vec::new();
    let mut win_start = 0usize;

    while win_start < total {
        let win_end = (win_start + window_len).min(total);
        let mut window: Vec<f32> = samples[win_start..win_end].to_vec();
        // Pad the final (short) window so the model always sees 10 s.
        if window.len() < window_len {
            window.resize(window_len, 0.0);
        }

        let activity = models.segment_window(&window)?;
        let frames = activity.len();
        if frames == 0 {
            win_start += window_len;
            continue;
        }
        // Frame duration derived from the model's own output resolution.
        let frame_secs = WINDOW_SECONDS / frames as f32;
        let samples_per_frame = (frame_secs * dsp::SAMPLE_RATE as f32) as usize;
        let win_start_secs = win_start as f32 / dsp::SAMPLE_RATE as f32;

        for spk in 0..MAX_LOCAL_SPEAKERS {
            // Contiguous runs of frames where this local speaker is active.
            let mut regions: Vec<(f32, f32)> = Vec::new();
            let mut overlapped_regions: Vec<(f32, f32)> = Vec::new();
            let mut audio: Vec<f32> = Vec::new();
            let mut run_start: Option<usize> = None;

            for f in 0..=frames {
                let active = f < frames && activity[f][spk];
                if active && run_start.is_none() {
                    run_start = Some(f);
                } else if !active {
                    if let Some(rs) = run_start.take() {
                        let s_secs = win_start_secs + rs as f32 * frame_secs;
                        let e_secs = win_start_secs + f as f32 * frame_secs;
                        // Clamp to real audio (the padded tail isn't real).
                        let e_secs = e_secs.min(duration);
                        if e_secs > s_secs {
                            regions.push((s_secs, e_secs));
                            // Keep overlap timing for multi-speaker transcript labels,
                            // but continue excluding it from speaker embeddings.
                            let mut overlap_start: Option<usize> = None;
                            for fi in rs..=f {
                                let overlapping = fi < f
                                    && activity[fi].iter().filter(|&&a| a).count() > 1;
                                if overlapping && overlap_start.is_none() {
                                    overlap_start = Some(fi);
                                } else if !overlapping {
                                    if let Some(os) = overlap_start.take() {
                                        let overlap_s = win_start_secs + os as f32 * frame_secs;
                                        let overlap_e = (win_start_secs + fi as f32 * frame_secs)
                                            .min(duration);
                                        if overlap_e > overlap_s {
                                            overlapped_regions.push((overlap_s, overlap_e));
                                        }
                                    }
                                }
                            }
                            // Gather samples for the embedding — but ONLY from
                            // frames where this speaker is the sole active one.
                            // Overlapped speech is assigned to every speaker
                            // talking, so including it would blend two voices
                            // into both embeddings and blur them together.
                            for fi in rs..f {
                                let exclusive =
                                    activity[fi].iter().filter(|&&a| a).count() == 1;
                                if !exclusive {
                                    continue;
                                }
                                let a = win_start + fi * samples_per_frame;
                                let b = (a + samples_per_frame).min(total);
                                if b > a && a < total {
                                    audio.extend_from_slice(&samples[a..b]);
                                }
                            }
                        }
                    }
                }
            }

            let speech_secs = audio.len() as f32 / dsp::SAMPLE_RATE as f32;
            if !regions.is_empty() && speech_secs >= MIN_EMBED_SECONDS {
                turns.push(LocalTurn {
                    regions,
                    overlapped_regions,
                    audio,
                    speech_secs,
                });
            }
        }

        win_start += window_len;
    }
    Ok(turns)
}

fn apply_source_track_hint(
    existing: Option<&str>,
    used_source_tracks: bool,
    allow_remote_hint: bool,
    labels: &mut Vec<String>,
) {
    if !used_source_tracks {
        return;
    }
    match existing {
        Some(speaker) if speaker.eq_ignore_ascii_case("you") => {
            labels.retain(|label| !label.eq_ignore_ascii_case("you"));
            labels.insert(0, "You".to_string());
        }
        Some(speaker) if allow_remote_hint && speaker.eq_ignore_ascii_case("guest") => {
            let has_remote = labels.iter().any(|label| {
                !label.eq_ignore_ascii_case("you") && !label.eq_ignore_ascii_case("guest")
            });
            if !has_remote && !labels.iter().any(|label| label.eq_ignore_ascii_case("guest")) {
                labels.push("Guest".to_string());
            }
        }
        _ => {}
    }
    if let Some(position) = labels.iter().position(|label| label.eq_ignore_ascii_case("you")) {
        let user = labels.remove(position);
        labels.insert(0, user);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Cancel made while nothing ran, or after a download's last chunk,
    /// must not stop the next download (a Pyannote repair included).
    #[test]
    fn a_new_download_starts_uncancelled() {
        download::request_cancel();
        let guard = begin_download().unwrap();
        assert!(!download::cancel_requested());
        drop(guard);
    }

    #[tokio::test]
    async fn label_reruns_preserve_text_timing_and_rollback_as_a_unit() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE transcripts(id TEXT PRIMARY KEY, meeting_id TEXT, transcript TEXT, audio_start_time REAL, audio_end_time REAL, speaker TEXT CHECK(speaker != 'invalid'))").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO transcripts VALUES ('a','m','Hello. 世界! Second turn.',1.25,9.5,'Guest'),('a-split-1','m','Retain this old row too.',9.5,12.0,'Guest'),('other','other','Private other meeting',0,1,'Named')").execute(&pool).await.unwrap();
        for label in ["Speaker 1", "You + Speaker 2"] {
            persist_speaker_labels(&pool,"m",vec![("a".into(),Some(label.into())),("other".into(),Some(label.into()))]).await.unwrap();
        }
        let rows: Vec<(String,String,f64,f64)> = sqlx::query_as("SELECT id,transcript,audio_start_time,audio_end_time FROM transcripts ORDER BY id").fetch_all(&pool).await.unwrap();
        assert_eq!(rows.len(),3);
        assert_eq!(rows[0],("a".into(),"Hello. 世界! Second turn.".into(),1.25,9.5));
        assert_eq!(rows[1].1,"Retain this old row too.");
        let failed = persist_speaker_labels(&pool,"m",vec![("a".into(),Some("Speaker 3".into())),("a-split-1".into(),Some("invalid".into()))]).await;
        assert!(failed.is_err());
        let labels: Vec<String> = sqlx::query_scalar("SELECT speaker FROM transcripts ORDER BY id").fetch_all(&pool).await.unwrap();
        assert_eq!(labels,vec!["You + Speaker 2","Guest","Named"]);
    }

    fn folder_with_audio(root: &Path, name: &str, metadata: Option<&str>) -> PathBuf {
        let folder = root.join(name);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("audio.mp4"), b"").unwrap();
        if let Some(metadata) = metadata {
            std::fs::write(folder.join("metadata.json"), metadata).unwrap();
        }
        folder.join("audio.mp4")
    }

    fn utc(value: &str) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339(value).unwrap().with_timezone(&chrono::Utc)
    }

    #[test]
    fn meeting_audio_lookup_prefers_the_folder_with_the_meeting_id() {
        let dir = tempfile::tempdir().unwrap();
        let configured = dir.path().join("custom-recordings");
        let default = dir.path().join("protocol-recordings");
        // An import names its folder before transcription, so its folder starts
        // further from `created_at` than a same-title recording does.
        let imported = folder_with_audio(
            &default,
            "Customer Interview_2026-09-01_08-40-00-000",
            Some(r#"{"meeting_id":"imported"}"#),
        );
        let recorded = folder_with_audio(
            &configured,
            "Customer Interview_2026-09-01_09-00-00-000",
            Some(r#"{"meeting_id":null}"#),
        );
        let lookup = |id, created_at| MeetingAudioLookup { id, title: "Customer Interview", created_at: utc(created_at) };

        for roots in [[configured.clone(), default.clone()], [default.clone(), configured.clone()]] {
            assert_eq!(
                find_meeting_folder_audio(&lookup("imported", "2026-09-01T09:00:00Z"), &roots),
                Some(imported.clone())
            );
            // Another meeting's folder is never a candidate, however close its start.
            assert_eq!(
                find_meeting_folder_audio(&lookup("recorded", "2026-09-01T08:40:00Z"), &roots),
                Some(recorded.clone())
            );
        }
    }

    #[test]
    fn meeting_audio_lookup_ignores_unrelated_folders_in_a_broad_root() {
        let dir = tempfile::tempdir().unwrap();
        let music = dir.path().join("Music");
        folder_with_audio(&music, "Weekly", None);
        folder_with_audio(&music, "Weekly Beats", None);
        folder_with_audio(&music, "Weekly Sync_2026-10-25_10-00-00-000", None);
        let meeting = MeetingAudioLookup { id: "weekly", title: "Weekly", created_at: utc("2026-10-25T10:00:00Z") };

        assert_eq!(find_meeting_folder_audio(&meeting, &[music]), None);
    }

    #[test]
    fn meeting_audio_lookup_finds_old_folder_without_metadata_by_start() {
        let dir = tempfile::tempdir().unwrap();
        let configured = dir.path().join("custom-recordings");
        let default = dir.path().join("protocol-recordings");
        // Saved before v0.2.12: a minute-precision name, no metadata, and a
        // `created_at` that is the save time after a 45-minute meeting.
        let old = folder_with_audio(&default, "Weekly Sync_2026-09-01_10-00", None);
        folder_with_audio(&default, "Weekly Sync_2026-08-31_10-00", None);
        folder_with_audio(&configured, "Weekly Sync_2026-09-01_14-00-00-000", Some(r#"{"meeting_id":null}"#));
        let roots = [dir.path().join("missing-root"), configured, default];
        let lookup = |created_at| MeetingAudioLookup { id: "weekly-sync", title: "Weekly Sync", created_at: utc(created_at) };

        assert_eq!(find_meeting_folder_audio(&lookup("2026-09-01T10:45:00Z"), &roots), Some(old));
        assert_eq!(find_meeting_folder_audio(&lookup("2026-09-03T10:00:00Z"), &roots), None);
    }

    #[test]
    fn meeting_folder_names_parse_every_start_format() {
        let parsed = |name| parse_meeting_folder_name(name).map(|(title, start)| (title.to_owned(), start.to_rfc3339()));
        let expect = |title: &str, start: &str| Some((title.to_owned(), start.to_owned()));

        assert_eq!(parsed("Sync_2026-09-01_10-00"), expect("Sync", "2026-09-01T10:00:00+00:00"));
        assert_eq!(parsed("Sync_2026-09-01_10-00-05"), expect("Sync", "2026-09-01T10:00:05+00:00"));
        assert_eq!(parsed("Q4_sync_2026-09-01_10-00-05-123"), expect("Q4_sync", "2026-09-01T10:00:05.123+00:00"));
        assert_eq!(parsed("Sync_2026-09-01_10-00-05-123_2"), expect("Sync", "2026-09-01T10:00:05.123+00:00"));
        assert_eq!(parsed("Weekly Beats"), None);
        assert_eq!(parsed("Live_2019_Remastered"), None);
    }

    fn seg(start: f32, end: f32, speaker: usize) -> DiarizationSegment {
        DiarizationSegment { start, end, speaker, overlapped: false }
    }

    fn row(id: &str, start: f64, end: f64, speaker: &str, hand_placed: bool) -> LabelRow {
        LabelRow { id: id.into(), start: Some(start), end: Some(end), speaker: Some(speaker.into()), hand_placed }
    }

    fn labels(plan: &LabelPlan) -> Vec<(&str, &str)> {
        plan.assignments.iter().map(|(id, label)| (id.as_str(), label.as_str())).collect()
    }

    /// Two voices: cluster 0 speaks 0-10 s and 20-30 s, cluster 1 10-20 s.
    fn two_voices() -> DiarizationResult {
        DiarizationResult {
            segments: vec![seg(0.0, 10.0, 0), seg(10.0, 20.0, 1), seg(20.0, 30.0, 0)],
            num_speakers: 2,
            duration: 30.0,
            user_speaker: None,
        }
    }

    /// #207's second cause: the meeting's only label was renamed, so every
    /// line carries the name. A rerun that finds two voices gives the name
    /// to the voice it overlaps most and "Speaker 2" to the other.
    #[test]
    fn a_rerun_splits_a_renamed_single_label_between_two_voices() {
        let rows: Vec<LabelRow> = [(0.0, 10.0), (10.0, 20.0), (20.0, 30.0)]
            .iter()
            .enumerate()
            .map(|(i, &(s, e))| row(&format!("t{i}"), s, e, "Anna", false))
            .collect();
        let plan = plan_labels(&rows, &two_voices(), &Default::default(), &["Anna".to_string()], false, None);
        assert_eq!(labels(&plan), vec![("t0", "Anna"), ("t1", "Speaker 2"), ("t2", "Anna")]);
        assert_eq!((plan.changed, plan.kept, plan.speakers_on_lines), (1, 0, 2));
        assert_eq!(plan.cluster_to_manual_name.get(&0).map(String::as_str), Some("Anna"));
    }

    /// A line moved by hand on its own keeps its label; the rest follow the
    /// clusters.
    #[test]
    fn a_line_moved_by_hand_keeps_its_label() {
        let rows = vec![
            row("t0", 0.0, 10.0, "Speaker 1", false),
            row("t1", 10.0, 20.0, "Boris", true),
            row("t2", 20.0, 30.0, "Speaker 1", false),
        ];
        let plan = plan_labels(&rows, &two_voices(), &Default::default(), &[], false, None);
        assert_eq!(labels(&plan), vec![("t0", "Speaker 1"), ("t1", "Boris"), ("t2", "Speaker 1")]);
        assert!(plan.updates.iter().all(|(id, _)| id != "t1"));
        assert_eq!(plan.kept, 1);
    }

    /// A run that ends with the labels the meeting had changes nothing, and
    /// says so with `changed` 0.
    #[test]
    fn a_rerun_with_the_same_result_changes_no_line() {
        let rows = vec![
            row("t0", 0.0, 10.0, "Speaker 1", false),
            row("t1", 10.0, 20.0, "Speaker 2", false),
            row("t2", 20.0, 30.0, "Speaker 1", false),
        ];
        let plan = plan_labels(&rows, &two_voices(), &Default::default(), &[], false, None);
        assert_eq!(plan.changed, 0);
        assert_eq!(plan.lines_per_label.get("Speaker 2"), Some(&1));
    }

    /// With a count chosen, a cluster that leads no line joins the line it
    /// covers the largest part of; detected, it is only reported.
    #[test]
    fn a_chosen_speaker_that_leads_no_line_joins_the_line_it_covers_most() {
        let result = DiarizationResult {
            segments: vec![seg(0.0, 10.0, 0), seg(10.0, 30.0, 0), seg(12.0, 13.0, 1), seg(25.0, 26.5, 1)],
            num_speakers: 2,
            duration: 30.0,
            user_speaker: None,
        };
        let rows = vec![row("t0", 0.0, 10.0, "Speaker 1", false), row("t1", 10.0, 20.0, "Speaker 1", false), row("t2", 20.0, 30.0, "Speaker 1", false)];
        // Overlapping speech counts only with 80 ms of simultaneous talk and a
        // fifth of the main voice, so cluster 1 is on no row by itself here.
        let detected = plan_labels(&rows, &result, &Default::default(), &[], false, None);
        assert_eq!(detected.speakers_on_lines, 1);
        let chosen = plan_labels(&rows, &result, &Default::default(), &[], false, Some(2));
        assert_eq!(chosen.speakers_on_lines, 2);
        assert_eq!(labels(&chosen)[2], ("t2", "Speaker 1 + Speaker 2"));
    }

    /// With source tracks a mic line keeps "You" first, and the three-label
    /// cap then drops a cluster; that cluster is not counted as on a line.
    #[test]
    fn a_cluster_the_source_hint_pushes_off_a_line_is_not_on_the_transcript() {
        let result = DiarizationResult {
            segments: vec![seg(0.0, 10.0, 1), seg(0.0, 10.0, 2), seg(0.0, 10.0, 3), seg(10.0, 20.0, 0)],
            num_speakers: 4,
            duration: 20.0,
            user_speaker: Some(0),
        };
        let rows = vec![row("t0", 0.0, 10.0, "You", false), row("t1", 10.0, 20.0, "You", false)];
        let plan = plan_labels(&rows, &result, &Default::default(), &[], true, None);
        assert_eq!(labels(&plan), vec![("t0", "You + Speaker 1 + Speaker 2"), ("t1", "You")]);
        assert_eq!((plan.speakers_on_lines, plan.labelled_before), (3, 2));
    }

    /// A line with no usable timing keeps a name the user gave; a generated
    /// label on such a line is cleared.
    #[test]
    fn a_line_without_timing_keeps_a_given_name() {
        let untimed = |id: &str, start: Option<f64>, end: Option<f64>, speaker: &str| LabelRow {
            id: id.into(),
            start,
            end,
            speaker: Some(speaker.into()),
            hand_placed: false,
        };
        let rows = vec![
            row("t0", 0.0, 10.0, "Speaker 1", false),
            untimed("t1", Some(12.0), Some(12.0), "Boris"),
            untimed("t2", None, None, "Speaker 2"),
            untimed("t3", Some(25.0), None, "Anna + Speaker 1"),
        ];
        let plan = plan_labels(&rows, &two_voices(), &Default::default(), &[], false, None);
        assert_eq!(labels(&plan), vec![("t0", "Speaker 1"), ("t1", "Boris"), ("t3", "Anna + Speaker 1")]);
        let update = |id: &str| plan.updates.iter().find(|(row, _)| row == id).map(|(_, label)| label.as_deref());
        assert_eq!(update("t1"), Some(Some("Boris")));
        assert_eq!(update("t2"), Some(None));
        assert_eq!((plan.kept, plan.changed), (2, 1));
    }

    /// The voiceprint guard reads the clusters before folding: one odd turn
    /// on the mic, which the automatic clustering folds into the user's
    /// voice, blocks enrolment.
    #[test]
    fn one_odd_turn_on_the_mic_blocks_voiceprint_enrolment() {
        let unit = |v: [f32; 3]| {
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            v.iter().map(|x| x / norm).collect::<Vec<f32>>()
        };
        let user: Vec<Vec<f32>> = (0..5).map(|i| unit([1.0, 0.02 * i as f32, 0.01 * i as f32])).collect();
        assert!(mic_is_one_consistent_voice(&user));

        let mut with_outlier = user.clone();
        with_outlier.insert(2, unit([0.1, 0.2, 0.97]));
        assert!(clustering::agglomerative(&with_outlier, None, DEFAULT_THRESHOLD).iter().all(|&l| l == 0));
        assert!(!mic_is_one_consistent_voice(&with_outlier));

        assert!(!mic_is_one_consistent_voice(&user[..2]));
    }

    #[test]
    fn a_row_takes_its_main_speaker_and_those_talking_over_them() {
        let turn = |start: f32, end: f32, speaker: usize| DiarizationSegment { start, end, speaker, overlapped: false };
        // Speaker 1 talks over speaker 0; speaker 2 follows without overlap.
        let segments = [turn(0.0, 6.0, 0), turn(4.0, 6.0, 1), turn(6.0, 9.0, 2)];

        assert_eq!(row_speakers(&segments, 0.0, 6.0), vec![0, 1]);
        // Speaker 2 overlaps the row for more than a fifth of speaker 0's
        // time, but never at the same time.
        assert_eq!(row_speakers(&segments, 0.0, 9.0)[0], 0);
        assert!(!row_speakers(&segments, 0.0, 9.0).contains(&2));
        assert_eq!(row_speakers(&segments, 6.5, 9.0), vec![2]);
        assert!(row_speakers(&segments, 10.0, 12.0).is_empty());
    }

    #[test]
    fn speakers_who_cover_a_row_equally_come_in_index_order() {
        let turn = |start: f32, end: f32, speaker: usize| DiarizationSegment { start, end, speaker, overlapped: false };
        // Three speakers talk over the whole row.
        let segments = [turn(0.0, 4.0, 2), turn(0.0, 4.0, 0), turn(0.0, 4.0, 1)];
        for _ in 0..20 {
            assert_eq!(row_speakers(&segments, 1.0, 3.0), vec![0, 1, 2]);
        }
    }

    #[test]
    fn two_tracks_merge_into_the_user_and_the_remote_speakers() {
        let turn = |start: f32, end: f32, speaker: usize| DiarizationSegment { start, end, speaker, overlapped: false };
        let result = |segments: Vec<DiarizationSegment>, num_speakers: usize, duration: f32| DiarizationResult {
            segments,
            num_speakers,
            duration,
            user_speaker: None,
        };
        // The microphone's diarizer split the user in two; the system track has two speakers.
        let mic = result(vec![turn(0.0, 2.0, 0), turn(5.0, 6.0, 1)], 2, 10.0);
        let system = result(vec![turn(1.5, 4.0, 0), turn(7.0, 9.0, 1)], 2, 12.0);

        let merged = merge_tracks(mic, system);
        let timeline: Vec<(f32, usize, bool)> = merged.segments.iter().map(|s| (s.start, s.speaker, s.overlapped)).collect();
        assert_eq!(timeline, [(0.0, 0, true), (1.5, 1, true), (5.0, 0, false), (7.0, 2, false)]);
        assert_eq!((merged.num_speakers, merged.duration, merged.user_speaker), (3, 12.0, Some(0)));
    }

    #[test]
    fn dual_track_user_hint_survives_missing_mic_segmentation() {
        let mut labels = vec!["Speaker 1".to_string()];
        apply_source_track_hint(Some("You"), true, true, &mut labels);

        assert_eq!(labels, vec!["You", "Speaker 1"]);
    }

    #[test]
    fn remote_hint_keeps_user_overlap_when_remote_segmentation_misses() {
        let mut labels = vec!["You".to_string()];
        apply_source_track_hint(Some("Guest"), true, true, &mut labels);

        assert_eq!(labels, vec!["You", "Guest"]);
    }

    #[test]
    fn dual_track_overlap_keeps_you_first_after_remote_clustering() {
        let mut labels = vec!["Speaker 1".to_string(), "You".to_string()];
        apply_source_track_hint(Some("Guest"), true, true, &mut labels);

        assert_eq!(labels, vec!["You", "Speaker 1"]);
    }

    #[test]
    fn mixed_recording_does_not_trust_source_hint() {
        let mut labels = vec!["Speaker 1".to_string()];
        apply_source_track_hint(Some("You"), false, true, &mut labels);

        assert_eq!(labels, vec!["Speaker 1"]);
    }

    #[test]
    fn explicit_solo_count_suppresses_remote_source_hint() {
        let mut labels = vec!["You".to_string()];
        apply_source_track_hint(Some("Guest"), true, false, &mut labels);

        assert_eq!(labels, vec!["You"]);
    }

    /// Headless evaluation of the diarization pipeline against a real
    /// recording. Skipped unless both env vars are set, e.g.:
    ///
    /// ```text
    /// DIARIZE_WAV=...\sample.wav DIARIZE_MODELS=...\resources\diarization \
    ///   cargo test --release --features cuda diarize_sample -- --nocapture
    /// ```
    #[test]
    fn diarize_sample() {
        let (wav, models) = match (
            std::env::var("DIARIZE_WAV"),
            std::env::var("DIARIZE_MODELS"),
        ) {
            (Ok(w), Ok(m)) => (w, m),
            _ => {
                eprintln!("skipping: set DIARIZE_WAV and DIARIZE_MODELS");
                return;
            }
        };
        // Optional diagnostic: dump the pairwise cosine-distance distribution
        // of the speaker embeddings. Well-separated embeddings should be
        // clearly bimodal (same-speaker pairs low, different-speaker high).
        if std::env::var("DIARIZE_DIAG").is_ok() {
            let embs = embeddings_for_debug(
                std::path::Path::new(&wav),
                std::path::Path::new(&models),
            )
            .expect("embedding extraction failed");
            println!("\n=== EMBEDDING DIAGNOSTIC ===");
            println!("turns embedded : {}", embs.len());
            if embs.len() >= 2 {
                let mut d: Vec<f32> = Vec::new();
                for i in 0..embs.len() {
                    for j in (i + 1)..embs.len() {
                        let dot: f32 = embs[i].iter().zip(&embs[j]).map(|(a, b)| a * b).sum();
                        d.push(1.0 - dot);
                    }
                }
                d.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let pct = |p: f32| d[((d.len() as f32 - 1.0) * p) as usize];
                println!("pairwise cosine distance over {} pairs:", d.len());
                println!("  min {:.3}  p10 {:.3}  p25 {:.3}  median {:.3}", d[0], pct(0.10), pct(0.25), pct(0.50));
                println!("  p75 {:.3}  p90 {:.3}  max {:.3}", pct(0.75), pct(0.90), d[d.len() - 1]);
                println!("  spread (p90-p10) = {:.3}", pct(0.90) - pct(0.10));
                let mut hist = [0usize; 10];
                for &v in &d { let b = ((v.max(0.0).min(0.999)) * 10.0) as usize; hist[b] += 1; }
                for (b, n) in hist.iter().enumerate() {
                    let bar = "#".repeat(((*n as f32 / d.len() as f32) * 60.0).round() as usize);
                    println!("  {:.1}-{:.1} |{} {}", b as f32 / 10.0, (b + 1) as f32 / 10.0, bar, n);
                }
            }
            println!("=== END DIAGNOSTIC ===\n");
            return;
        }
        // Optional sweep: DIARIZE_SWEEP="0.65,0.70,0.75" runs each threshold
        // in one process so the build cost is paid once.
        if let Ok(sweep) = std::env::var("DIARIZE_SWEEP") {
            println!("\n=== THRESHOLD SWEEP: {} ===", wav);
            for t in sweep.split(',') {
                let t: f32 = match t.trim().parse() { Ok(v) => v, Err(_) => continue };
                let r = diarize_file_with_models(
                    std::path::Path::new(&wav),
                    std::path::Path::new(&models),
                    None,
                    Some(t),
                ).expect("diarization failed");
                let mut talk = std::collections::BTreeMap::<usize, f32>::new();
                for s in &r.segments { *talk.entry(s.speaker).or_insert(0.0) += s.end - s.start; }
                let mut dist: Vec<String> = talk.values()
                    .map(|v| format!("{:.0}%", (v / r.duration) * 100.0)).collect();
                dist.sort_by(|a, b| b.len().cmp(&a.len()));
                println!(
                    "  thr {:.2} -> {} speakers, {} segments   [{}]",
                    t, r.num_speakers, r.segments.len(), dist.join(" ")
                );
            }
            println!("=== END SWEEP ===\n");
            return;
        }
        let threshold = std::env::var("DIARIZE_THRESHOLD")
            .ok()
            .and_then(|v| v.parse::<f32>().ok());
        let num_speakers = std::env::var("DIARIZE_SPEAKERS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok());

        let started = std::time::Instant::now();
        let result = diarize_file_with_models(
            std::path::Path::new(&wav),
            std::path::Path::new(&models),
            num_speakers,
            threshold,
        )
        .expect("diarization failed");

        println!("\n=== DIARIZATION RESULT ===");
        println!("audio duration : {:.1}s", result.duration);
        println!("wall time      : {:.1}s", started.elapsed().as_secs_f32());
        println!("threshold      : {:?}", threshold);
        println!("speakers found : {}", result.num_speakers);
        println!("segments       : {}", result.segments.len());
        println!("--------------------------");
        let mut talk = std::collections::BTreeMap::<usize, f32>::new();
        for s in &result.segments {
            *talk.entry(s.speaker).or_insert(0.0) += s.end - s.start;
            println!(
                "{:>7.2} -> {:>7.2}  ({:>5.2}s)  Speaker {}",
                s.start,
                s.end,
                s.end - s.start,
                s.speaker + 1
            );
        }
        println!("--------------------------");
        for (spk, secs) in &talk {
            println!(
                "Speaker {} total: {:.1}s ({:.0}% of audio)",
                spk + 1,
                secs,
                (secs / result.duration) * 100.0
            );
        }
        println!("==========================\n");
    }
}
