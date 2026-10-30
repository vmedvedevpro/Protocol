//! The kit's inputs, read from `MEASURE_*` environment variables.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, ensure, Context, Result};
use sha2::{Digest, Sha256};

/// What every command reads.
pub struct Inputs {
    /// An audio file, or a recording folder with `mic.mp4` and `system.mp4`.
    pub audio: PathBuf,
    /// The folder the JSON outputs go to.
    pub out: PathBuf,
    /// The app's language setting: a code such as `ru`, or `auto`.
    pub language: String,
    /// The vocabulary the app passes to the engines, if any.
    pub vocabulary: Option<String>,
    pub span: Option<Span>,
}

impl Inputs {
    pub fn from_env() -> Result<Self> {
        let out = path("MEASURE_OUT", "the folder for the JSON outputs (outside git for a private recording)")?;
        std::fs::create_dir_all(&out).with_context(|| format!("creating MEASURE_OUT {}", out.display()))?;
        Ok(Self {
            audio: existing_path("MEASURE_AUDIO", "an audio file, or a recording folder with mic.mp4 and system.mp4")?,
            out,
            language: optional("MEASURE_LANGUAGE").unwrap_or_else(|| "auto".to_string()),
            vocabulary: optional("MEASURE_VOCABULARY"),
            span: optional("MEASURE_SPAN").map(|span| Span::parse(&span)).transpose()?,
        })
    }

    /// The SHA-256 of the vocabulary as given. The outputs record it instead
    /// of the text, which can be private, so that the scoring can tell two
    /// vocabularies apart.
    pub fn vocabulary_sha256(&self) -> Option<String> {
        self.vocabulary.as_deref().map(|vocabulary| format!("{:x}", Sha256::digest(vocabulary.as_bytes())))
    }
}

/// A variable's value, unless it is unset or blank.
pub fn optional(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty())
}

/// A relative path is taken from the repository root, where the documented
/// commands start: cargo runs a test binary in the package folder.
fn path(name: &str, what: &str) -> Result<PathBuf> {
    let path = optional(name).map(PathBuf::from).ok_or_else(|| anyhow!("{name} is not set: {what}"))?;
    let package = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = package.parent().and_then(Path::parent).unwrap_or(package);
    Ok(root.join(path))
}

/// A path that must exist: an input that is read in place.
pub fn existing_path(name: &str, what: &str) -> Result<PathBuf> {
    let path = path(name, what)?;
    ensure!(path.exists(), "{name} is {}, which does not exist: {what}", path.display());
    Ok(path)
}

/// The part of a recording to measure, in ms from its start.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Span {
    pub start_ms: f64,
    pub end_ms: f64,
}

impl Span {
    /// `start-end`, each in seconds or as `[h:]m:ss`: `1500-2700`, `25:00-45:00`.
    pub fn parse(text: &str) -> Result<Self> {
        let (start, end) = text
            .split_once('-')
            .ok_or_else(|| anyhow!("MEASURE_SPAN is {text}: write start-end, as 25:00-45:00 or 1500-2700"))?;
        let span = Self { start_ms: seconds(start)? * 1000.0, end_ms: seconds(end)? * 1000.0 };
        ensure!(span.start_ms < span.end_ms, "MEASURE_SPAN {text} ends before it starts");
        Ok(span)
    }

    /// Whether the stretch from `start_ms` to `end_ms` reaches into the span.
    pub fn overlaps(&self, start_ms: f64, end_ms: f64) -> bool {
        start_ms < self.end_ms && end_ms > self.start_ms
    }

    /// The span inside a recording of `duration_ms`: its end cut to the
    /// recording's, an error when it starts at or after it.
    pub fn within(self, duration_ms: f64) -> Result<Self> {
        ensure!(
            self.start_ms < duration_ms,
            "MEASURE_SPAN starts at {:.1} s, but the recording ends at {:.1} s",
            self.start_ms / 1000.0,
            duration_ms / 1000.0
        );
        Ok(Self { start_ms: self.start_ms, end_ms: self.end_ms.min(duration_ms) })
    }
}

fn seconds(text: &str) -> Result<f64> {
    let mut total = 0.0;
    for part in text.trim().split(':') {
        match part.parse::<f64>() {
            Ok(value) if value.is_finite() && value >= 0.0 => total = total * 60.0 + value,
            _ => bail!("{text:?} in MEASURE_SPAN is not a time"),
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_span_is_read_in_seconds_or_minutes() {
        let span = Span::parse("25:00-45:00").unwrap();
        assert_eq!((span.start_ms, span.end_ms), (1_500_000.0, 2_700_000.0));
        assert_eq!(Span::parse("1500-2700").unwrap(), span);
        assert_eq!(Span::parse("1:00:00-1:00:30.5").unwrap().end_ms, 3_630_500.0);
    }

    #[test]
    fn a_piece_that_reaches_into_the_span_is_measured() {
        let span = Span::parse("100-200").unwrap();
        assert!(span.overlaps(95_000.0, 101_000.0));
        assert!(span.overlaps(199_000.0, 230_000.0));
        assert!(!span.overlaps(90_000.0, 100_000.0));
        assert!(!span.overlaps(200_000.0, 210_000.0));
    }

    #[test]
    fn a_span_ends_with_the_recording() {
        let span = Span::parse("100-200").unwrap();
        assert_eq!(span.within(150_000.0).unwrap(), Span { start_ms: 100_000.0, end_ms: 150_000.0 });
        assert!(span.within(100_000.0).is_err());
    }

    #[test]
    fn the_vocabulary_is_recorded_by_its_hash() {
        let inputs = |vocabulary: Option<&str>| Inputs {
            audio: PathBuf::new(),
            out: PathBuf::new(),
            language: "auto".to_string(),
            vocabulary: vocabulary.map(str::to_string),
            span: None,
        };
        assert_eq!(
            inputs(Some("abc")).vocabulary_sha256().as_deref(),
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert_eq!(inputs(None).vocabulary_sha256(), None);
    }

    #[test]
    fn a_span_that_is_not_a_time_range_is_refused() {
        assert!(Span::parse("25:00").is_err());
        assert!(Span::parse("45:00-25:00").is_err());
        assert!(Span::parse("a-b").is_err());
    }
}
