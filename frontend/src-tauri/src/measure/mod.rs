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
//! Both call the product's functions: the batch VAD with each engine's cap,
//! the 25 s cut and the skip rule of the post-meeting pass, its
//! `PieceTranscriber`, the live Whisper call, Parakeet, the per-track
//! language detection, and `diarize_meeting`'s row labelling. They do not
//! score: `scripts/measure/` reads the JSON.
//!
//! Recordings and models are read in place. Only `MEASURE_OUT` is written
//! (and the app's empty data folder beside the test binary, see `engines`);
//! for a private recording it holds private transcripts: keep it outside
//! the repository.

mod diarize;
mod engines;
mod input;
mod output;
mod settings;
mod tracks;

use anyhow::{ensure, Result};

use diarize::Diarizer;
use engines::Engines;
use input::{existing_path, optional, Inputs};
use settings::Setting;

fn init_logging() {
    let filter = "info,ort=warn,app_lib::audio::vad=warn,symphonia_format_isomp4=warn";
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(filter)).try_init();
}

/// Inputs: `MEASURE_AUDIO`, `MEASURE_OUT`, `MEASURE_SETTINGS`,
/// `MEASURE_WHISPER_MODEL` and/or `MEASURE_PARAKEET_MODEL`, and optionally
/// `MEASURE_LANGUAGE`, `MEASURE_VOCABULARY`, `MEASURE_SPAN`,
/// `MEASURE_DIARIZATION` with `MEASURE_DIARIZATION_MODEL`.
#[tokio::test]
#[ignore = "measurement command; inputs from MEASURE_* (docs/MEASURING_TRANSCRIPTION.md)"]
async fn transcribe_settings() -> Result<()> {
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

    let tracks = tracks::load(&inputs.audio)?;
    let speakers = match &diarizer {
        Some(diarizer) => {
            let (speakers, timelines) = diarize::diarize(diarizer, &tracks, inputs.span.as_ref())?;
            output::write(&inputs.out, "diarization", &timelines)?;
            speakers
        }
        None => Vec::new(),
    };

    let engines = Engines::open(whisper_model.as_deref(), parakeet_model.as_deref()).await?;
    let mut runs = Vec::new();
    for setting in settings {
        let mut run = settings::run(setting, &engines, &tracks, &inputs).await?;
        diarize::label_rows(&mut run, &tracks, &speakers);
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
    init_logging();
    let inputs = Inputs::from_env()?;
    let model = existing_path("MEASURE_REFERENCE_MODEL", "the Large V3 ggml file the reference is decoded with")?;
    ensure!(!inputs.out.join("reference.json").exists(), "{} has a reference.json already", inputs.out.display());

    let tracks = tracks::load(&inputs.audio)?;
    let engines = Engines::open(Some(&model), None).await?;
    let run = settings::run(Setting::Reference, &engines, &tracks, &inputs).await?;
    output::write(&inputs.out, "reference", &run)?;
    output::print_table(&[run]);
    Ok(())
}
