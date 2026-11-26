//! The Speech check's sample (#233): two clips of FLEURS read speech
//! (Google, CC BY 4.0), Russian and English, each with two voices taking
//! turns, built by `scripts/measure/measure.py speech-check-sample`
//! (`scripts/measure/kit/speech_check.py`). `sample.json` names each clip's
//! file, its text and its turns. They are the app's own resources
//! (`resources/speech-check/`, [`set_bundled_dir`]), installed and signed
//! with it.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use super::score::Turn;

#[derive(Debug, Clone, Deserialize)]
pub struct VoiceTurn {
    pub start_ms: f64,
    pub end_ms: f64,
    /// `a` (a woman's reading) or `b` (a man's).
    pub voice: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ClipEntry {
    id: String,
    file: String,
    turns: Vec<VoiceTurn>,
}

#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    clips: Vec<ClipEntry>,
}

/// One clip, decoded.
#[derive(Debug, Clone)]
pub struct Clip {
    pub id: String,
    /// 16 kHz mono.
    pub samples: Vec<f32>,
    pub turns: Vec<VoiceTurn>,
}

impl Clip {
    /// The words of every turn in time order: what a transcript should say.
    pub fn text(&self) -> String {
        self.turns.iter().map(|turn| turn.text.as_str()).collect::<Vec<_>>().join(" ")
    }

    pub fn duration_ms(&self) -> f64 {
        self.samples.len() as f64 / 16.0
    }

    /// The turns with each voice numbered in the order it first speaks.
    pub fn voices(&self) -> Vec<Turn> {
        let mut names: Vec<&str> = Vec::new();
        self.turns
            .iter()
            .map(|turn| {
                let label = names.iter().position(|name| *name == turn.voice).unwrap_or_else(|| {
                    names.push(&turn.voice);
                    names.len() - 1
                });
                Turn { start_ms: turn.start_ms, end_ms: turn.end_ms, label }
            })
            .collect()
    }
}

static BUNDLED: OnceLock<PathBuf> = OnceLock::new();

/// The folder of the bundled sample, set at startup from the resource folder.
pub fn set_bundled_dir(dir: PathBuf) {
    let _ = BUNDLED.set(dir);
}

fn bundled_dir() -> Result<&'static Path> {
    BUNDLED.get().map(PathBuf::as_path).ok_or_else(|| anyhow!("the app's resource folder is not known"))
}

/// The sample's clips, decoded.
pub fn load() -> Result<Vec<Clip>> {
    load_from(bundled_dir()?)
}

pub(crate) fn load_from(dir: &Path) -> Result<Vec<Clip>> {
    let manifest_path = dir.join("sample.json");
    let manifest: Manifest = serde_json::from_slice(
        &std::fs::read(&manifest_path).with_context(|| format!("the sample is missing ({})", manifest_path.display()))?,
    )
    .context("the sample's list is unreadable")?;
    manifest
        .clips
        .into_iter()
        .map(|entry| {
            let decoded = crate::audio::decoder::decode_audio_file(&dir.join(&entry.file)).with_context(|| format!("the sample clip {} did not decode", entry.file))?;
            Ok(Clip { id: entry.id, samples: decoded.to_whisper_format(), turns: entry.turns })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The clips the app bundles, as `measure.py speech-check-sample` built them.
    #[test]
    fn the_bundled_sample_decodes_to_its_turns() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/speech-check");
        let clips = load_from(&dir).unwrap();
        assert_eq!(clips.iter().map(|clip| clip.id.as_str()).collect::<Vec<_>>(), ["ru", "en"]);
        for clip in clips {
            assert_eq!(clip.turns.len(), 4);
            let last = clip.turns.last().unwrap().end_ms;
            assert!((clip.duration_ms() - last).abs() < 20.0, "{} lasts {} ms, its turns end at {last}", clip.id, clip.duration_ms());
        }
    }
}
