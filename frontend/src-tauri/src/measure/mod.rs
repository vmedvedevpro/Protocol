//! Measurement kit for transcription changes (#75). The method, the setup and
//! how to read the numbers: docs/MEASURING_TRANSCRIPTION.md.
//!
//! The commands are ignored tests, so the normal test build compiles them
//! against the code they measure and never runs them:
//!
//! - [`transcribe_settings`] runs the compared settings (`MEASURE_SETTINGS`)
//!   on one recording in one process and writes `<setting>.json`: every
//!   piece with its rows, times and speakers.
//! - [`build_reference`] writes `reference.json`: Large V3 decoding one VAD
//!   utterance per call, beam search 5 at temperature 0, without timestamps.
//!
//! Both run the product's code: the post-meeting pass's VAD, pieces and loop
//! over them (`audio::post_meeting`: skip rule, per-track language, engine
//! call, silence-hallucination filter), the live worker's call and skip
//! rule, the reference call beside the pass's Whisper call, and
//! `diarize_meeting`'s calls on two tracks, its timeline and its row
//! labelling. They do not score:
//! `scripts/measure/` reads the JSON.
//!
//! Recordings and models are read in place. Only `MEASURE_OUT` is written
//! (and the app's data folder, see `engines`); for a private recording it
//! holds private transcripts and, while Pyannote runs, a WAV of a track:
//! keep it outside the repository.

mod diarize;
mod engines;
mod input;
mod output;
mod settings;
mod tracks;

use std::path::Path;
use std::time::Instant;

use anyhow::{ensure, Context, Result};

use diarize::Diarizer;
use engines::Engines;
use input::{existing_path, optional, Inputs, Span};
use settings::Setting;
use tracks::{Cut, Track};

/// The tracks are 16 kHz.
const SAMPLES_PER_MS: f64 = 16.0;

/// Held by each command while it runs. Libtest runs both on parallel threads
/// when a filter selects both (`measure -- --ignored` without `--exact`):
/// they would share the GPU, the post-meeting pass's process-wide greedy
/// fallback and `MEASURE_OUT`, and every time would include the other's work.
static ONE_COMMAND: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn ms_since(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// A model's file or folder name, for the outputs.
fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into_owned())
}

fn init_logging() {
    let filter = "info,ort=warn,app_lib::audio::vad=warn,symphonia_format_isomp4=warn";
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(filter)).try_init();
}

/// `MEASURE_SPAN` inside the recording.
fn recording_span(tracks: &[Track], span: Option<Span>) -> Result<Option<Span>> {
    let duration_ms = tracks.iter().map(Track::duration_ms).fold(0.0, f64::max);
    span.map(|span| span.within(duration_ms)).transpose()
}

/// Inputs: `MEASURE_AUDIO`, `MEASURE_OUT`, `MEASURE_SETTINGS`,
/// `MEASURE_WHISPER_MODEL` and/or `MEASURE_PARAKEET_MODEL`, and optionally
/// `MEASURE_LANGUAGE`, `MEASURE_VOCABULARY`, `MEASURE_SPAN`,
/// `MEASURE_DIARIZATION` with `MEASURE_DIARIZATION_MODEL`.
#[tokio::test]
#[ignore = "measurement command; inputs from MEASURE_* (docs/MEASURING_TRANSCRIPTION.md)"]
async fn transcribe_settings() -> Result<()> {
    let _one = ONE_COMMAND.lock().await;
    init_logging();
    let inputs = Inputs::from_env()?;
    let settings = Setting::list(optional("MEASURE_SETTINGS").as_deref())?;
    let whisper_model = settings.iter().any(|s| s.uses_whisper())
        .then(|| existing_path("MEASURE_WHISPER_MODEL", "the ggml model file of the Whisper settings"))
        .transpose()?;
    let parakeet_model = settings.contains(&Setting::Parakeet)
        .then(|| existing_path("MEASURE_PARAKEET_MODEL", "the Parakeet model folder"))
        .transpose()?;
    let diarizer = Diarizer::from_env()?;

    let mut tracks = tracks::load(&inputs.audio)?;
    let span = recording_span(&tracks, inputs.span)?;
    // The app diarizes whole tracks; so does the kit, also for a span.
    let timeline = match &diarizer {
        Some(diarizer) => {
            let (timeline, diarization) = diarize::diarize(diarizer, &tracks, &inputs.out)?;
            output::write(&inputs.out, "diarization", &diarization)?;
            Some(timeline)
        }
        None => None,
    };
    // Settings with the same VAD cap transcribe the same pieces.
    let mut cuts: Vec<Cut> = Vec::new();
    for setting in &settings {
        if !cuts.iter().any(|cut| cut.cap == setting.cap()) {
            cuts.push(tracks::cut(&tracks, setting.cap())?);
        }
    }
    tracks.iter_mut().for_each(Track::release_samples);

    let engines = Engines::open(whisper_model.as_deref(), parakeet_model.as_deref()).await?;
    let mut runs = Vec::new();
    for setting in settings {
        let cut = cuts.iter().find(|cut| cut.cap == setting.cap()).context("every setting's cap is cut")?;
        let mut run = settings::run(setting, &engines, &tracks, cut, span, &inputs).await?;
        if let Some(timeline) = &timeline {
            diarize::label_rows(&mut run, timeline);
        }
        output::write(&inputs.out, setting.name(), &run)?;
        runs.push(run);
    }
    output::print_table(&runs);
    Ok(())
}

/// Inputs: `MEASURE_AUDIO`, `MEASURE_OUT`, `MEASURE_REFERENCE_MODEL` (Large
/// V3, f16), and optionally `MEASURE_LANGUAGE`, `MEASURE_VOCABULARY`,
/// `MEASURE_SPAN`. Give the reference the language and vocabulary of the
/// settings it will score.
#[tokio::test]
#[ignore = "measurement command; inputs from MEASURE_* (docs/MEASURING_TRANSCRIPTION.md)"]
async fn build_reference() -> Result<()> {
    let _one = ONE_COMMAND.lock().await;
    init_logging();
    let inputs = Inputs::from_env()?;
    let model = existing_path("MEASURE_REFERENCE_MODEL", "the Large V3 ggml file the reference is decoded with")?;
    ensure!(!inputs.out.join("reference.json").exists(), "{} has a reference.json already", inputs.out.display());

    let mut tracks = tracks::load(&inputs.audio)?;
    let span = recording_span(&tracks, inputs.span)?;
    let cut = tracks::cut(&tracks, Setting::Reference.cap())?;
    tracks.iter_mut().for_each(Track::release_samples);
    let engines = Engines::open(Some(&model), None).await?;
    let run = settings::run(Setting::Reference, &engines, &tracks, &cut, span, &inputs).await?;
    output::write(&inputs.out, "reference", &run)?;
    output::print_table(&[run]);
    Ok(())
}
