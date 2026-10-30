//! A recording's tracks and the pieces the post-meeting pass cuts them into,
//! as `run_retranscription` reads and cuts them.

use std::path::Path;
use std::time::Instant;

use anyhow::{Context, Result};

use super::{ms_since, SAMPLES_PER_MS};
use crate::audio::decoder::decode_audio_file;
use crate::audio::post_meeting;
use crate::audio::retranscription::{find_audio_file, find_retranscription_sources};
use crate::audio::vad::{ContinuousSpeechCap, SpeechSegment};

/// One decoded track: 16 kHz mono samples and the VAD thresholds the pass
/// uses for it.
pub struct Track {
    pub label: &'static str,
    pub speaker_hint: Option<&'static str>,
    pub samples: Vec<f32>,
    positive_threshold: f32,
    negative_threshold: f32,
}

impl Track {
    pub fn duration_ms(&self) -> f64 {
        self.samples.len() as f64 / SAMPLES_PER_MS
    }
}

/// The tracks a retranscription reads: a recording folder's microphone and
/// system tracks, or its single audio file. A file given on its own is read
/// as a recording without retained tracks, one track with the default
/// thresholds, which is also how the import reads a file.
pub fn load(input: &Path) -> Result<Vec<Track>> {
    let sources = if input.is_dir() {
        find_retranscription_sources(input, &find_audio_file(input)?)
    } else {
        // A file has no mic.mp4 or system.mp4 inside it, so this is the fallback.
        find_retranscription_sources(input, input)
    };
    sources
        .into_iter()
        .map(|source| {
            let decoded =
                decode_audio_file(&source.path).with_context(|| format!("decoding {}", source.path.display()))?;
            Ok(Track {
                label: source.label,
                speaker_hint: source.speaker_hint,
                samples: decoded.to_whisper_format(),
                positive_threshold: source.positive_threshold,
                negative_threshold: source.negative_threshold,
            })
        })
        .collect()
}

/// A piece and the label of its track. The label is the track's key in the
/// pass, as the speaker hint is in retranscription: both are distinct per
/// track.
pub type Piece = (SpeechSegment, &'static str);

/// The pieces of a whole recording for one VAD cap.
pub struct Cut {
    pub cap: ContinuousSpeechCap,
    /// The batch VAD over all tracks.
    pub vad_ms: f64,
    pub pieces: Vec<Piece>,
}

/// The pieces a post-meeting pass transcribes with this VAD cap: the pass's
/// batch VAD on every whole track, then `post_meeting::pieces` (time order,
/// those over 25 s cut at their quietest points).
pub fn cut(tracks: &[Track], cap: ContinuousSpeechCap) -> Result<Cut> {
    let started = Instant::now();
    let mut speech = Vec::new();
    for track in tracks {
        let segments =
            post_meeting::speech(&track.samples, track.positive_threshold, track.negative_threshold, cap, |_, _| true)
                .with_context(|| format!("VAD on the {} track", track.label))?;
        speech.extend(segments.into_iter().map(|segment| (segment, track.label)));
    }
    let pieces = post_meeting::pieces(speech);
    Ok(Cut { cap, vad_ms: ms_since(started), pieces })
}
