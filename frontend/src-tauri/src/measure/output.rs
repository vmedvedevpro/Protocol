//! The JSON the commands write, which `scripts/measure/` reads, and the short
//! table they print. Times are ms from the start of the recording; a
//! `wall_ms` is time measured on the clock.

use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

/// Raised when a field changes meaning; the scoring checks it.
pub const FORMAT: u32 = 1;

/// One setting's run over a recording: `<setting>.json`.
#[derive(Serialize)]
pub struct Run {
    pub format: u32,
    pub setting: &'static str,
    pub model: String,
    pub acceleration: &'static str,
    /// Debug builds are several times slower: timing compares optimized runs only.
    pub optimized: bool,
    pub language: String,
    pub vocabulary: bool,
    /// Settings › Labs › strict silence threshold for Whisper, read from the
    /// test binary's own data folder (see `engines`), so off unless set there.
    pub whisper_strict_silence: bool,
    /// `MEASURE_SPAN` inside the recording. The pieces are those that reach
    /// into it, whole; the scoring clips their words to it.
    pub span_ms: Option<[f64; 2]>,
    pub tracks: Vec<TrackInfo>,
    pub timing: Timing,
    pub pieces: Vec<PieceResult>,
}

#[derive(Serialize)]
pub struct TrackInfo {
    pub label: &'static str,
    pub speaker_hint: Option<&'static str>,
    /// The language detected once for the track on Auto and used for all its
    /// pieces; `None` when none was (a set language, or calls that detect
    /// their own).
    pub language: Option<String>,
}

#[derive(Serialize, Default)]
pub struct Timing {
    /// The untimed first call of the setting (see `settings::run`).
    pub warmup_ms: f64,
    /// The batch VAD over the whole tracks, also for a span. Settings with
    /// the same VAD cap share one VAD pass and report its time.
    pub vad_ms: f64,
    /// Language detection on Auto, once per track over the whole recording.
    pub detection_ms: f64,
    /// The transcription calls, summed.
    pub transcription_ms: f64,
    /// The audio of the pieces given to the engine.
    pub speech_ms: f64,
}

#[derive(Serialize)]
pub struct PieceResult {
    pub track: &'static str,
    pub start_ms: f64,
    pub end_ms: f64,
    /// Why the setting's path skipped the piece without a call.
    pub skipped: Option<&'static str>,
    /// The retranscription loop drops the piece as a silence hallucination.
    pub dropped: bool,
    pub wall_ms: f64,
    pub rows: Vec<Row>,
}

#[derive(Serialize)]
pub struct Row {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
    /// The diarized speakers `diarize_meeting` gives the row, the main one
    /// first; absent on a track that was not diarized.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speakers: Option<Vec<usize>>,
}

/// The speaker timelines: `diarization.json`.
#[derive(Serialize)]
pub struct Diarization {
    pub format: u32,
    pub engine: &'static str,
    pub model: String,
    pub tracks: Vec<Timeline>,
}

#[derive(Serialize)]
pub struct Timeline {
    pub track: &'static str,
    /// The diarized part of the track.
    pub start_ms: f64,
    pub end_ms: f64,
    pub wall_ms: f64,
    pub speakers: usize,
    pub segments: Vec<Turn>,
}

#[derive(Serialize)]
pub struct Turn {
    pub start_ms: f64,
    pub end_ms: f64,
    pub speaker: usize,
    pub overlapped: bool,
}

pub fn write(folder: &Path, name: &str, value: &impl Serialize) -> Result<()> {
    let path = folder.join(format!("{name}.json"));
    let file = std::fs::File::create(&path).with_context(|| format!("creating {}", path.display()))?;
    serde_json::to_writer_pretty(std::io::BufWriter::new(file), value)?;
    println!("wrote {}", path.display());
    Ok(())
}

/// Pieces, rows and time per setting; the scoring prints the accuracy.
pub fn print_table(runs: &[Run]) {
    println!();
    println!("{:<14} {:>7} {:>8} {:>6} {:>9} {:>8} {:>8} {:>10}", "setting", "pieces", "skipped", "rows", "speech s",
        "time s", "warm-up", "x realtime");
    for run in runs {
        let t = &run.timing;
        let time_ms = t.detection_ms + t.transcription_ms;
        let skipped = run.pieces.iter().filter(|p| p.skipped.is_some()).count();
        let rows: usize = run.pieces.iter().map(|p| p.rows.len()).sum();
        println!(
            "{:<14} {:>7} {:>8} {:>6} {:>9.1} {:>8.1} {:>8.1} {:>10.1}",
            run.setting,
            run.pieces.len(),
            skipped,
            rows,
            t.speech_ms / 1000.0,
            time_ms / 1000.0,
            t.warmup_ms / 1000.0,
            t.speech_ms / time_ms.max(1.0),
        );
    }
    if runs.iter().any(|run| !run.optimized) {
        println!("(debug build: compare times only between release runs)");
    }
}
