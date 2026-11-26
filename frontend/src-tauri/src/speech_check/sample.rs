//! The Speech check's sample (#233): two clips of FLEURS read speech
//! (Google, CC BY 4.0), Russian and English, each with two voices taking
//! turns, built by `scripts/measure/measure.py speech-check-sample`
//! (`scripts/measure/kit/speech_check.py`). `sample.json` names each clip's
//! file with its SHA-256, its text and its turns.
//!
//! Where the clips come from is [`load`]'s business alone: today the app's
//! resources (`resources/speech-check/`, [`set_bundled_dir`]); the catalog
//! could serve them instead without the rest of the check changing.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{anyhow, ensure, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::score::Turn;

/// The format `sample.json` is written in (`speech_check.py`'s `FORMAT`).
const FORMAT: u32 = 1;

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
    language: String,
    file: String,
    sha256: String,
    turns: Vec<VoiceTurn>,
}

#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    format: u32,
    clips: Vec<ClipEntry>,
}

/// One clip, decoded.
#[derive(Debug, Clone)]
pub struct Clip {
    pub id: String,
    pub language: String,
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

    pub fn voices(&self) -> Vec<Turn<&str>> {
        self.turns.iter().map(|turn| Turn { start_ms: turn.start_ms, end_ms: turn.end_ms, label: turn.voice.as_str() }).collect()
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

/// The sample's clips, checked against their SHA-256 and decoded.
pub fn load() -> Result<Vec<Clip>> {
    load_from(bundled_dir()?)
}

pub(crate) fn load_from(dir: &Path) -> Result<Vec<Clip>> {
    let manifest_path = dir.join("sample.json");
    let manifest: Manifest = serde_json::from_slice(
        &std::fs::read(&manifest_path).with_context(|| format!("the sample is missing ({})", manifest_path.display()))?,
    )
    .context("the sample's list is unreadable")?;
    ensure!(manifest.format == FORMAT, "the sample's list has format {}, not {FORMAT}", manifest.format);
    manifest
        .clips
        .into_iter()
        .map(|entry| {
            // A name, never a path: the list cannot point outside its folder.
            ensure!(Path::new(&entry.file).file_name() == Some(std::ffi::OsStr::new(&entry.file)), "bad sample file name {}", entry.file);
            let path = dir.join(&entry.file);
            let bytes = std::fs::read(&path).with_context(|| format!("the sample clip {} is missing", entry.file))?;
            ensure!(format!("{:x}", Sha256::digest(&bytes)) == entry.sha256, "the sample clip {} is damaged", entry.file);
            let decoded = crate::audio::decoder::decode_audio_file(&path).with_context(|| format!("decoding {}", entry.file))?;
            Ok(Clip { id: entry.id, language: entry.language, samples: decoded.to_whisper_format(), turns: entry.turns })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_damaged_or_missing_clip_is_refused() {
        let folder = tempfile::tempdir().unwrap();
        assert!(load_from(folder.path()).unwrap_err().to_string().contains("the sample is missing"));
        let manifest = r#"{"format": 1, "clips": [{"id": "ru", "language": "ru", "file": "ru.flac", "sha256": "00", "turns": []}]}"#;
        std::fs::write(folder.path().join("sample.json"), manifest).unwrap();
        assert!(load_from(folder.path()).unwrap_err().to_string().contains("missing"));
        std::fs::write(folder.path().join("ru.flac"), b"not flac").unwrap();
        assert!(load_from(folder.path()).unwrap_err().to_string().contains("damaged"));
        let escaping = r#"{"format": 1, "clips": [{"id": "ru", "language": "ru", "file": "../x.flac", "sha256": "00", "turns": []}]}"#;
        std::fs::write(folder.path().join("sample.json"), escaping).unwrap();
        assert!(load_from(folder.path()).unwrap_err().to_string().contains("bad sample file name"));
    }

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
