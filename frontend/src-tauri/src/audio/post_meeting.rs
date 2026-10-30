//! Shared parts of the post-meeting pass, retranscription and import (#62):
//! how the batch VAD cuts the audio for each engine, which pieces are skipped,
//! how a piece's Whisper segments become transcript rows, and the language
//! when the setting is Auto.
//!
//! Whisper gets pieces that run from pause to pause (the batch VAD without its
//! continuous-speech cap) and decodes them with timestamps
//! (`whisper_engine::post_meeting`); each Whisper segment becomes a row, so a
//! speaker change inside a piece still falls on a row boundary when Whisper
//! starts a new segment there. Parakeet keeps the capped pieces, one row each.

use std::fmt::Debug;

use anyhow::anyhow;
use log::{info, warn};

use crate::audio::vad::{ContinuousSpeechCap, SpeechSegment};
use crate::parakeet_engine::ParakeetEngine;
use crate::whisper_engine::post_meeting::PostMeetingWhisper;
use crate::whisper_engine::{TimedText, WhisperEngine};

/// The batch VAD's continuous-speech cap for each engine.
///
/// The cap came with live streaming (Actually Free `f4b2399`): it bounds the
/// live buffer and gives text and online diarization a turn every few seconds.
/// The batch path inherited it from the VAD constructor. None of those reasons
/// holds for Whisper after the meeting: the file is already in memory, Whisper
/// reads 30 s at a time (pieces over 25 s are still split at silence), and the
/// rows come from Whisper's own segments, not from the pieces. A cut inside
/// continuous speech can only lose or double a word, so Whisper gets no cap.
/// Parakeet keeps it: its rows are whole pieces, and it was not measured on
/// longer ones.
pub fn vad_cap(use_parakeet: bool) -> ContinuousSpeechCap {
    if use_parakeet {
        ContinuousSpeechCap::Streaming
    } else {
        ContinuousSpeechCap::PauseToPause
    }
}

pub fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|x| x * x).sum::<f32>() / samples.len().max(1) as f32).sqrt()
}

/// Why the post-meeting loops skip a piece without transcribing it: whisper.cpp
/// rejects input under 100 ms, and a silent piece (RMS < 0.005 and peak < 0.01)
/// only invites a silence hallucination. The language detection skips the same
/// pieces.
pub fn skip_reason(samples: &[f32]) -> Option<&'static str> {
    if samples.len() < 1600 {
        return Some("short");
    }
    let peak = samples.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    (rms(samples) < 0.005 && peak < 0.01).then_some("silent")
}

/// Transcribes the pieces of one post-meeting pass with the engine the pass
/// loaded: Parakeet gives one row per piece, Whisper one row per segment.
pub struct PieceTranscriber<'a> {
    parakeet: Option<&'a ParakeetEngine>,
    whisper: Option<PostMeetingWhisper<'a>>,
}

impl<'a> PieceTranscriber<'a> {
    /// Parakeet when the pass loaded it, otherwise Whisper.
    pub fn new(parakeet: Option<&'a ParakeetEngine>, whisper: Option<&'a WhisperEngine>) -> Self {
        Self { parakeet, whisper: whisper.map(PostMeetingWhisper::new) }
    }

    /// The rows of one piece that have text, as (text, start ms, end ms) in
    /// meeting time. `language` is the Whisper setting for this piece.
    pub async fn rows(
        &mut self,
        piece: &SpeechSegment,
        language: Option<&str>,
        vocabulary: Option<&str>,
    ) -> anyhow::Result<Vec<(String, f64, f64)>> {
        let rows = if let Some(parakeet) = self.parakeet {
            let text = parakeet
                .transcribe_audio(piece.samples.clone(), vocabulary)
                .await
                .map_err(|error| anyhow!("Parakeet transcription failed: {error}"))?;
            vec![(text, piece.start_timestamp_ms, piece.end_timestamp_ms)]
        } else if let Some(whisper) = self.whisper.as_mut() {
            let segments = whisper
                .transcribe_piece(&piece.samples, language, vocabulary)
                .await
                .map_err(|error| anyhow!("Whisper transcription failed: {error}"))?;
            rows_from_piece(piece, segments)
        } else {
            return Err(anyhow!("No transcription engine is loaded"));
        };
        Ok(rows.into_iter().filter(|(text, _, _)| !text.trim().is_empty()).collect())
    }
}

/// The rows of one piece: each Whisper segment with meeting times (ms), kept
/// inside the piece. Whisper times a segment from the piece start in 10 ms
/// steps and may place a timestamp past the audio's end.
///
/// A segment whose two timestamps coincide joins the row before it (the first
/// one joins the row after it): diarization labels a row by the speech its
/// time span overlaps and clears the label of a row without duration.
fn rows_from_piece(piece: &SpeechSegment, segments: Vec<TimedText>) -> Vec<(String, f64, f64)> {
    let (piece_start, piece_end) = (piece.start_timestamp_ms, piece.end_timestamp_ms.max(piece.start_timestamp_ms));
    let mut rows: Vec<(String, f64, f64)> = Vec::new();
    let mut pending = String::new();
    for segment in segments {
        let start = (piece_start + segment.start_ms).clamp(piece_start, piece_end);
        let end = (piece_start + segment.end_ms).clamp(start, piece_end);
        if end > start {
            let text = if pending.is_empty() { segment.text } else { format!("{} {}", std::mem::take(&mut pending), segment.text) };
            rows.push((text, start, end));
        } else if let Some((text, _, _)) = rows.last_mut() {
            text.push(' ');
            text.push_str(&segment.text);
        } else {
            if !pending.is_empty() {
                pending.push(' ');
            }
            pending.push_str(&segment.text);
        }
    }
    if !pending.is_empty() {
        // Only segments without duration: one row over the whole piece.
        rows.push((pending, piece_start, piece_end));
    }
    rows
}

/// whisper.cpp detects the language on the first 30 s of its input.
const DETECTION_SAMPLES: usize = 30 * 16_000;

/// A track's detected language is used for all its pieces only when whisper.cpp
/// gives it more probability than all other languages together. Below that the
/// track keeps per-call detection, as before #62: one wrong detection would
/// otherwise decode the whole track in the wrong language.
const MIN_TRACK_LANGUAGE_PROBABILITY: f32 = 0.5;

/// Whether a Whisper pass with this language setting detects it once per track.
/// With Auto, whisper.cpp otherwise detects it in every call (one more encoder
/// pass per piece; on a measured meeting with 6 s pieces it made the pass 54 %
/// slower and misread 7 of 230 short or noisy pieces). "auto-translate" and
/// Parakeet keep their behaviour. Limit: a track whose speakers switch language
/// mid-meeting is transcribed in the one detected language.
pub fn detects_once(language: Option<&str>) -> bool {
    matches!(language, None | Some("auto"))
}

/// Up to 30 s of one track's speech for the detection: its longest pieces
/// among those the pass transcribes, joined in time order.
pub fn detection_audio<'a>(segments: impl IntoIterator<Item = &'a SpeechSegment>) -> Vec<f32> {
    let mut longest: Vec<&SpeechSegment> =
        segments.into_iter().filter(|s| skip_reason(&s.samples).is_none()).collect();
    longest.sort_by(|a, b| b.samples.len().cmp(&a.samples.len()));
    let mut chosen = Vec::new();
    let mut total = 0;
    for segment in longest {
        if total >= DETECTION_SAMPLES {
            break;
        }
        total += segment.samples.len();
        chosen.push(segment);
    }
    chosen.sort_by(|a, b| a.start_timestamp_ms.total_cmp(&b.start_timestamp_ms));
    let mut audio: Vec<f32> = chosen.iter().flat_map(|segment| segment.samples.iter().copied()).collect();
    audio.truncate(DETECTION_SAMPLES);
    audio
}

/// Whether a detection is confident enough to fix a track's language.
fn confident(probability: f32) -> bool {
    probability > MIN_TRACK_LANGUAGE_PROBABILITY
}

/// The language of one track's pieces, or `None` when the track keeps per-call
/// detection (no speech, a failed or unconfident detection).
pub async fn detect_once<'a>(
    engine: &WhisperEngine,
    track: impl Debug,
    segments: impl IntoIterator<Item = &'a SpeechSegment>,
) -> Option<String> {
    let audio = detection_audio(segments);
    if audio.is_empty() {
        return None;
    }
    let seconds = audio.len() as f64 / 16_000.0;
    match engine.detect_language_with_probability(&audio).await {
        Ok(Some((language, probability))) if confident(probability) => {
            info!("Detected language {language} (p = {probability:.2}) for {track:?} on {seconds:.1}s of speech");
            Some(language)
        }
        Ok(Some((language, probability))) => {
            warn!("Language {language} for {track:?} has p = {probability:.2}; detecting per piece");
            None
        }
        Ok(None) => {
            warn!("No language detected for {track:?}; detecting per piece");
            None
        }
        Err(error) => {
            warn!("Language detection failed for {track:?}: {error}; detecting per piece");
            None
        }
    }
}

/// [`detect_once`] for each distinct `track` among `segments`, stopping when
/// `cancelled` says so. A track without a language is left out.
pub async fn detect_per_track<'a, K: Copy + PartialEq + Debug>(
    engine: &WhisperEngine,
    segments: impl IntoIterator<Item = (&'a SpeechSegment, K)>,
    cancelled: impl Fn() -> bool,
) -> Vec<(K, String)> {
    let mut tracks: Vec<(K, Vec<&SpeechSegment>)> = Vec::new();
    for (segment, track) in segments {
        match tracks.iter_mut().find(|(known, _)| *known == track) {
            Some((_, list)) => list.push(segment),
            None => tracks.push((track, vec![segment])),
        }
    }
    let mut languages = Vec::new();
    for (track, list) in tracks {
        if cancelled() {
            break;
        }
        if let Some(language) = detect_once(engine, track, list).await {
            languages.push((track, language));
        }
    }
    languages
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(start_s: f64, seconds: f64, level: f32) -> SpeechSegment {
        SpeechSegment {
            samples: vec![level; (seconds * 16_000.0) as usize],
            start_timestamp_ms: start_s * 1000.0,
            end_timestamp_ms: (start_s + seconds) * 1000.0,
            confidence: 0.9,
        }
    }

    fn timed(start_ms: f64, end_ms: f64, text: &str) -> TimedText {
        TimedText { start_ms, end_ms, text: text.to_string() }
    }

    #[test]
    fn whisper_pieces_run_from_pause_to_pause_and_parakeet_keeps_the_cap() {
        assert_eq!(vad_cap(false), ContinuousSpeechCap::PauseToPause);
        assert_eq!(vad_cap(true), ContinuousSpeechCap::Streaming);
    }

    #[test]
    fn short_and_silent_pieces_are_skipped() {
        assert_eq!(skip_reason(&[0.5; 1599]), Some("short"));
        assert_eq!(skip_reason(&[0.004; 16_000]), Some("silent"));
        assert_eq!(skip_reason(&[0.02; 16_000]), None);
        let mut quiet_with_a_click = vec![0.001; 16_000];
        quiet_with_a_click[100] = 0.5;
        assert_eq!(skip_reason(&quiet_with_a_click), None);
    }

    #[test]
    fn rows_take_whisper_times_inside_the_piece() {
        let piece = segment(100.0, 20.0, 0.1);
        let rows = rows_from_piece(
            &piece,
            vec![timed(0.0, 7_400.0, "first"), timed(7_400.0, 12_900.0, "second"), timed(18_000.0, 21_500.0, "last")],
        );
        assert_eq!(
            rows,
            vec![
                ("first".to_string(), 100_000.0, 107_400.0),
                ("second".to_string(), 107_400.0, 112_900.0),
                // Whisper may place the last timestamp past the audio; the row ends with the piece.
                ("last".to_string(), 118_000.0, 120_000.0),
            ]
        );
    }

    #[test]
    fn a_segment_without_duration_joins_a_neighbouring_row() {
        let piece = segment(10.0, 10.0, 0.1);
        let rows = rows_from_piece(
            &piece,
            vec![
                timed(500.0, 500.0, "a"),
                timed(500.0, 3_000.0, "b"),
                timed(3_000.0, 3_000.0, "c"),
                timed(3_000.0, 6_000.0, "d"),
            ],
        );
        assert_eq!(rows, vec![("a b c".to_string(), 10_500.0, 13_000.0), ("d".to_string(), 13_000.0, 16_000.0)]);
        // Past the piece's end both timestamps clamp to it.
        let rows = rows_from_piece(&piece, vec![timed(0.0, 9_000.0, "e"), timed(10_400.0, 11_000.0, "f")]);
        assert_eq!(rows, vec![("e f".to_string(), 10_000.0, 19_000.0)]);
        let rows = rows_from_piece(&piece, vec![timed(2_000.0, 2_000.0, "g")]);
        assert_eq!(rows, vec![("g".to_string(), 10_000.0, 20_000.0)]);
    }

    #[test]
    fn only_auto_is_detected_once() {
        assert!(detects_once(None));
        assert!(detects_once(Some("auto")));
        assert!(!detects_once(Some("auto-translate")));
        assert!(!detects_once(Some("ru")));
    }

    #[test]
    fn a_track_language_needs_more_than_half_of_the_probability() {
        assert!(confident(0.93));
        assert!(!confident(0.5));
        assert!(!confident(0.41));
    }

    #[test]
    fn detection_takes_the_longest_speech_in_time_order() {
        let segments = [
            segment(0.0, 6.0, 0.1),
            segment(10.0, 2.0, 0.2),
            segment(20.0, 6.0, 0.3),
            segment(30.0, 6.0, 0.4),
            segment(40.0, 6.0, 0.5),
            segment(50.0, 5.0, 0.6),
            segment(60.0, 4.0, 0.7),
        ];
        let audio = detection_audio(&segments);
        assert_eq!(audio.len(), DETECTION_SAMPLES);
        // 6 + 6 + 6 + 6 + 5 + 4 s: the 2 s piece is left out, the 4 s one is cut at 30 s.
        assert_eq!(audio[0], 0.1);
        assert!(!audio.contains(&0.2));
        assert_eq!(audio[28 * 16_000], 0.6);
        assert_eq!(audio[29 * 16_000], 0.7);
        assert_eq!(audio[DETECTION_SAMPLES - 1], 0.7);
    }

    #[test]
    fn detection_skips_what_the_pass_skips() {
        let segments = [segment(0.0, 20.0, 0.001), segment(30.0, 0.05, 0.5), segment(40.0, 3.0, 0.5)];
        let audio = detection_audio(&segments);
        assert_eq!(audio.len(), 3 * 16_000);
        assert!(detection_audio(&segments[..2]).is_empty());
    }
}
