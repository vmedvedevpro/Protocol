//! The speaker timeline `diarize_meeting` builds, and the speakers it gives
//! the rows.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};

use super::input::{existing_path, optional};
use super::output::{self, Run, Turn};
use super::tracks::Track;
use super::{file_name, ms_since};
use crate::diarization::nemotron::NemotronDiarizationModel;
use crate::diarization::{
    diarize_file_with_models, diarize_track_wavs, row_speakers, DiarizationConfig, DiarizationResult,
    DiarizationSegment, TrackEngine,
};

const SAMPLE_RATE: u32 = 16_000;

pub enum Diarizer {
    Nemotron(PathBuf),
    Pyannote(PathBuf),
}

impl Diarizer {
    /// `MEASURE_DIARIZATION` (`nemotron` or `pyannote`) with its
    /// `MEASURE_DIARIZATION_MODEL`; `None` when speakers are not measured.
    pub fn from_env() -> Result<Option<Self>> {
        let Some(engine) = optional("MEASURE_DIARIZATION") else { return Ok(None) };
        let model = existing_path(
            "MEASURE_DIARIZATION_MODEL",
            "the Nemotron .onnx file, or the folder with the Pyannote models",
        )?;
        Ok(Some(match engine.as_str() {
            "nemotron" => Self::Nemotron(model),
            "pyannote" => Self::Pyannote(model),
            other => bail!("MEASURE_DIARIZATION is {other:?}: use nemotron or pyannote"),
        }))
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Nemotron(_) => "nemotron",
            Self::Pyannote(_) => "pyannote",
        }
    }

    fn model(&self) -> &Path {
        match self {
            Self::Nemotron(path) | Self::Pyannote(path) => path,
        }
    }

    /// A recording without retained tracks, as `diarize_file_with_engine`
    /// diarizes it.
    fn diarize_one(&self, track: &Track, scratch: &Path) -> Result<DiarizationResult> {
        match self {
            Self::Nemotron(model) => nemotron(model)?.diarize(&track.samples, SAMPLE_RATE),
            Self::Pyannote(models) => pyannote(models, &track.samples, scratch),
        }
    }

    /// A microphone and a system track through `diarize_meeting`'s own
    /// function for them (`diarize_track_wavs`), which reads a WAV of each:
    /// they are written under `scratch`, as Pyannote's is for one track. The
    /// voiceprint the app updates from the microphone is left alone.
    fn diarize_two(&self, mic: &Track, system: &Track, scratch: &Path) -> Result<DiarizationResult> {
        let folder = tempfile::tempdir_in(scratch)?;
        let (mic_wav, system_wav) = (folder.path().join("mic.wav"), folder.path().join("system.wav"));
        write_wav(&mic_wav, &mic.samples)?;
        write_wav(&system_wav, &system.samples)?;
        let config = DiarizationConfig::default();
        let engine = match self {
            Self::Nemotron(model) => TrackEngine::Nemotron { model, config: &config },
            Self::Pyannote(models) => TrackEngine::Pyannote { models },
        };
        diarize_track_wavs(engine, &mic_wav, &system_wav, None, None)
            .context("diarizing the microphone and system tracks")
    }
}

/// The app's default parameters (`DiarizationConfig::default`), not the ones
/// a user may have saved.
fn nemotron(model: &Path) -> Result<NemotronDiarizationModel> {
    let config = DiarizationConfig::default();
    NemotronDiarizationModel::new(model, config.nemotron_max_speakers, config.nemotron_threshold)
}

/// The Pyannote pipeline reads a WAV file. It is written under `scratch`
/// (`MEASURE_OUT`): for a private recording it is private audio, and it stays
/// if the process is killed.
fn pyannote(models: &Path, samples: &[f32], scratch: &Path) -> Result<DiarizationResult> {
    let folder = tempfile::tempdir_in(scratch)?;
    let wav = folder.path().join("track.wav");
    write_wav(&wav, samples)?;
    diarize_file_with_models(&wav, models, None, None)
}

/// The recording's speaker timeline as `diarize_meeting` builds it, in
/// seconds for `row_speakers`: a microphone and a system track each diarized
/// whole and merged, or the one track. The temporary WAVs go under
/// `scratch`.
pub fn diarize(diarizer: &Diarizer, tracks: &[Track], scratch: &Path) -> Result<(Vec<DiarizationSegment>, output::Diarization)> {
    let started = Instant::now();
    let result = match tracks {
        [track] => diarizer.diarize_one(track, scratch).with_context(|| format!("diarizing the {}", track.label))?,
        [mic, system] => diarizer.diarize_two(mic, system, scratch)?,
        _ => bail!("{} tracks: a recording has one track, or a microphone and a system track", tracks.len()),
    };
    let wall_ms = ms_since(started);
    log::info!("{}: {} speakers in {:.1} s", diarizer.name(), result.num_speakers, wall_ms / 1000.0);
    let diarization = output::Diarization {
        format: output::FORMAT,
        engine: diarizer.name(),
        model: file_name(diarizer.model()),
        tracks: tracks.iter().map(|track| track.label).collect(),
        wall_ms,
        speakers: result.num_speakers,
        segments: result
            .segments
            .iter()
            .map(|s| Turn {
                start_ms: s.start as f64 * 1000.0,
                end_ms: s.end as f64 * 1000.0,
                speaker: s.speaker,
                overlapped: s.overlapped,
            })
            .collect(),
    };
    Ok((result.segments, diarization))
}

/// Gives every row its speakers on the recording's timeline, as
/// `diarize_meeting` does for the rows of every track. A row without
/// duration gets none (the app clears its label).
pub fn label_rows(run: &mut Run, timeline: &[DiarizationSegment]) {
    for row in run.pieces.iter_mut().flat_map(|piece| piece.rows.iter_mut()) {
        let (start, end) = ((row.start_ms / 1000.0) as f32, (row.end_ms / 1000.0) as f32);
        row.speakers = Some(if end > start { row_speakers(timeline, start, end) } else { Vec::new() });
    }
}

/// 16 kHz mono 32-bit float, so the engines read the samples the kit decoded
/// (`dsp::read_wav` reads this format). The app gives them ffmpeg's 16-bit
/// WAV of each track instead (`ensure_wav`); the kit has no ffmpeg, and that
/// WAV would go to the OS temp folder. Written through a buffer, not built in
/// memory: a track can be several hundred MB.
fn write_wav(path: &Path, samples: &[f32]) -> Result<()> {
    // A RIFF size is 32-bit: about 18 hours of these samples.
    let data_bytes = u32::try_from(samples.len() * 4)
        .ok()
        .filter(|bytes| bytes.checked_add(36).is_some())
        .context("the track is too long for a WAV file")?;
    let write = || -> std::io::Result<()> {
        let mut out = BufWriter::new(File::create(path)?);
        out.write_all(b"RIFF")?;
        out.write_all(&(36 + data_bytes).to_le_bytes())?;
        out.write_all(b"WAVEfmt ")?;
        out.write_all(&16u32.to_le_bytes())?;
        out.write_all(&3u16.to_le_bytes())?; // IEEE float
        out.write_all(&1u16.to_le_bytes())?; // mono
        out.write_all(&SAMPLE_RATE.to_le_bytes())?;
        out.write_all(&(SAMPLE_RATE * 4).to_le_bytes())?; // bytes per second
        out.write_all(&4u16.to_le_bytes())?; // bytes per frame
        out.write_all(&32u16.to_le_bytes())?;
        out.write_all(b"data")?;
        out.write_all(&data_bytes.to_le_bytes())?;
        for sample in samples {
            out.write_all(&sample.to_le_bytes())?;
        }
        out.flush()
    };
    write().with_context(|| format!("writing {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pyannote_reads_the_samples_it_is_given() {
        let folder = tempfile::tempdir().unwrap();
        let wav = folder.path().join("track.wav");
        let samples = [0.0, 0.25, -0.5, 1.5];
        write_wav(&wav, &samples).unwrap();
        assert_eq!(crate::diarization::dsp::read_wav(&wav).unwrap(), (samples.to_vec(), 16_000));
    }
}
