//! A recording's tracks and the pieces the post-meeting pass cuts them into,
//! as `run_retranscription` reads and cuts them.

use std::path::Path;

use anyhow::{Context, Result};

use super::input::Span;
use crate::audio::common::split_segment_at_silence;
use crate::audio::decoder::decode_audio_file;
use crate::audio::retranscription::{
    find_audio_file, find_retranscription_sources, MAX_SEGMENT_SAMPLES, VAD_REDEMPTION_TIME_MS,
};
use crate::audio::vad::{get_speech_chunks_with_cap_and_progress, ContinuousSpeechCap, SpeechSegment};

/// One decoded track: 16 kHz mono samples and the VAD thresholds the pass
/// uses for it.
pub struct Track {
    pub label: &'static str,
    pub speaker_hint: Option<&'static str>,
    pub samples: Vec<f32>,
    positive_threshold: f32,
    negative_threshold: f32,
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

/// A piece of one track (an index into the tracks).
pub struct Piece {
    pub track: usize,
    pub segment: SpeechSegment,
}

/// The pieces a post-meeting pass transcribes with this VAD cap: the batch
/// VAD per track, all pieces in time order, those over 25 s cut at their
/// quietest point. With a span, the pieces that start inside it; the VAD
/// still reads whole tracks, so they are the pieces of the whole recording.
pub fn pieces(tracks: &[Track], cap: ContinuousSpeechCap, span: Option<&Span>) -> Result<Vec<Piece>> {
    let mut found = Vec::new();
    for (index, track) in tracks.iter().enumerate() {
        let segments = get_speech_chunks_with_cap_and_progress(
            &track.samples,
            VAD_REDEMPTION_TIME_MS,
            track.positive_threshold,
            track.negative_threshold,
            cap,
            |_, _| true,
        )
        .with_context(|| format!("VAD on the {} track", track.label))?;
        found.extend(segments.into_iter().map(|segment| (index, segment)));
    }
    found.sort_by(|a, b| a.1.start_timestamp_ms.total_cmp(&b.1.start_timestamp_ms));
    Ok(found
        .iter()
        .flat_map(|(track, segment)| {
            split_segment_at_silence(segment, MAX_SEGMENT_SAMPLES)
                .into_iter()
                .map(move |segment| Piece { track: *track, segment })
        })
        .filter(|piece| span.map_or(true, |span| span.contains(piece.segment.start_timestamp_ms)))
        .collect())
}
