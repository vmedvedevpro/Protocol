//! Speaker timelines and the labels `diarize_meeting` gives the rows.

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};

use super::input::{existing_path, optional, Span};
use super::output::{self, Run, Timeline, Turn};
use super::tracks::Track;
use crate::diarization::nemotron::NemotronDiarizationModel;
use crate::diarization::{diarize_file_with_models, row_speakers, DiarizationConfig, DiarizationResult, DiarizationSegment};

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

    /// The app's default parameters (`DiarizationConfig::default`), not the
    /// ones a user may have saved.
    fn diarize(&self, samples: &[f32]) -> Result<DiarizationResult> {
        let config = DiarizationConfig::default();
        match self {
            Self::Nemotron(model) => {
                NemotronDiarizationModel::new(model, config.nemotron_max_speakers, config.nemotron_threshold)?
                    .diarize(samples, 16_000)
            }
            // The Pyannote pipeline reads a WAV file.
            Self::Pyannote(models) => {
                let folder = tempfile::tempdir()?;
                let wav = folder.path().join("track.wav");
                write_wav(&wav, samples)?;
                diarize_file_with_models(&wav, models, None, None)
            }
        }
    }
}

/// One track's speakers, in seconds from the start of the recording, as
/// `DiarizationSegment`s for `row_speakers`.
pub struct TrackSpeakers {
    pub track: usize,
    segments: Vec<DiarizationSegment>,
}

/// Diarizes the tracks `diarize_meeting` splits into speakers, over the span
/// if there is one. The microphone track (hint `You`) is left out: the app
/// labels all of it as the user.
pub fn diarize(diarizer: &Diarizer, tracks: &[Track], span: Option<&Span>) -> Result<(Vec<TrackSpeakers>, output::Diarization)> {
    let mut speakers = Vec::new();
    let mut timelines = Vec::new();
    for (index, track) in tracks.iter().enumerate().filter(|(_, track)| track.speaker_hint != Some("You")) {
        let track_ms = track.samples.len() as f64 / 16.0;
        let (start_ms, end_ms) = span.map_or((0.0, track_ms), |span| (span.start_ms, span.end_ms.min(track_ms)));
        let audio = &track.samples[(start_ms * 16.0) as usize..(end_ms * 16.0) as usize];
        let started = Instant::now();
        let result = diarizer.diarize(audio).with_context(|| format!("diarizing the {} track", track.label))?;
        let wall_ms = started.elapsed().as_secs_f64() * 1000.0;
        log::info!("{}: {} speakers on the {} track in {:.1} s", diarizer.name(), result.num_speakers, track.label, wall_ms / 1000.0);

        let offset_s = (start_ms / 1000.0) as f32;
        let segments: Vec<DiarizationSegment> = result
            .segments
            .into_iter()
            .map(|segment| DiarizationSegment { start: segment.start + offset_s, end: segment.end + offset_s, ..segment })
            .collect();
        timelines.push(Timeline {
            track: track.label,
            start_ms,
            end_ms,
            wall_ms,
            speakers: result.num_speakers,
            segments: segments
                .iter()
                .map(|s| Turn {
                    start_ms: s.start as f64 * 1000.0,
                    end_ms: s.end as f64 * 1000.0,
                    speaker: s.speaker,
                    overlapped: s.overlapped,
                })
                .collect(),
        });
        speakers.push(TrackSpeakers { track: index, segments });
    }
    let diarization = output::Diarization {
        format: output::FORMAT,
        engine: diarizer.name(),
        model: diarizer.model().file_name().map_or_else(String::new, |name| name.to_string_lossy().into_owned()),
        tracks: timelines,
    };
    Ok((speakers, diarization))
}

/// Gives every row of a diarized track its speakers, as `diarize_meeting`
/// chooses them. A row without duration gets none (the app clears its label).
pub fn label_rows(run: &mut Run, tracks: &[Track], speakers: &[TrackSpeakers]) {
    for piece in &mut run.pieces {
        let Some(timeline) = speakers.iter().find(|t| tracks[t.track].label == piece.track) else { continue };
        for row in &mut piece.rows {
            let (start, end) = ((row.start_ms / 1000.0) as f32, (row.end_ms / 1000.0) as f32);
            row.speakers = Some(if end > start { row_speakers(&timeline.segments, start, end) } else { Vec::new() });
        }
    }
}

/// 16 kHz mono 32-bit float, so Pyannote reads the samples the other
/// engines get (`dsp::read_wav` reads this format).
fn write_wav(path: &Path, samples: &[f32]) -> Result<()> {
    let data_bytes = (samples.len() * 4) as u32;
    let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    bytes.extend_from_slice(&1u16.to_le_bytes()); // mono
    bytes.extend_from_slice(&16_000u32.to_le_bytes());
    bytes.extend_from_slice(&64_000u32.to_le_bytes()); // bytes per second
    bytes.extend_from_slice(&4u16.to_le_bytes()); // bytes per frame
    bytes.extend_from_slice(&32u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))
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
