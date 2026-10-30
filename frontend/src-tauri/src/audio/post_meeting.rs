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
/// reads 30 s at a time (pieces over 25 s are cut at their quietest point), and the
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
/// A segment without duration joins the row before it (the first one joins
/// the row after it): diarization labels a row by the speech its time span
/// overlaps and clears the label of a row without duration. Whisper's
/// segments get no duration when their timestamps coincide or both lie past
/// the piece's end, and a decode that loops often goes on that way, so such a
/// segment with the same words as the segment before it is dropped instead of
/// joining. Rows that loop with duration then merge ([`merge_repeated_rows`]).
fn rows_from_piece(piece: &SpeechSegment, segments: Vec<TimedText>) -> Vec<(String, f64, f64)> {
    let (piece_start, piece_end) = (piece.start_timestamp_ms, piece.end_timestamp_ms.max(piece.start_timestamp_ms));
    let mut rows: Vec<(String, f64, f64)> = Vec::new();
    let mut pending = String::new();
    let mut previous_words: Vec<String> = Vec::new();
    for segment in segments {
        let start = (piece_start + segment.start_ms).clamp(piece_start, piece_end);
        let end = (piece_start + segment.end_ms).clamp(start, piece_end);
        let segment_words = words(&segment.text);
        if end > start {
            let text = if pending.is_empty() { segment.text } else { format!("{} {}", std::mem::take(&mut pending), segment.text) };
            rows.push((text, start, end));
        } else if segment_words == previous_words {
            continue;
        } else if let Some((text, _, _)) = rows.last_mut() {
            text.push(' ');
            text.push_str(&segment.text);
        } else {
            if !pending.is_empty() {
                pending.push(' ');
            }
            pending.push_str(&segment.text);
        }
        previous_words = segment_words;
    }
    if !pending.is_empty() {
        // Only segments without duration: one row over the whole piece.
        rows.push((pending, piece_start, piece_end));
    }
    merge_repeated_rows(rows)
}

/// A text's words, lower case, without punctuation.
fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect()
}

/// From this many consecutive rows with the same words on, a piece's rows are
/// taken for a loop. Two in a row are as often one speaker answering twice, or
/// two speakers on one track, and cost at most one extra word if they are a
/// loop after all.
const LOOP_ROWS: usize = 3;

/// A run of [`LOOP_ROWS`] or more consecutive rows of one piece with the same
/// words (case and punctuation aside) becomes one row over their joint time.
/// A timestamped decode can loop as one short segment after another ("Да."
/// fifteen times); the repetition cleanup sees one segment at a time and
/// leaves text under three words alone, so the loop would otherwise stay as a
/// row per repeat.
fn merge_repeated_rows(rows: Vec<(String, f64, f64)>) -> Vec<(String, f64, f64)> {
    let keys: Vec<Vec<String>> = rows.iter().map(|(text, _, _)| words(text)).collect();
    let mut merged: Vec<(String, f64, f64)> = Vec::with_capacity(rows.len());
    let mut first = 0;
    while first < rows.len() {
        let mut next = first + 1;
        while next < rows.len() && keys[next] == keys[first] {
            next += 1;
        }
        if next - first >= LOOP_ROWS {
            merged.push((rows[first].0.clone(), rows[first].1, rows[next - 1].2));
        } else {
            merged.extend_from_slice(&rows[first..next]);
        }
        first = next;
    }
    merged
}

/// Rows of a pass in time order, each with its own tag (a speaker hint). A
/// piece adds all its rows, up to about 28 s of them, before the next piece,
/// and the pieces of two tracks interleave, so the rows of one track's piece
/// can start after the next piece of the other track. The sort is stable:
/// rows that start together keep their order.
pub fn in_time_order<T>(rows: Vec<(String, f64, f64)>, tags: Vec<T>) -> (Vec<(String, f64, f64)>, Vec<T>) {
    let mut tagged: Vec<((String, f64, f64), T)> = rows.into_iter().zip(tags).collect();
    tagged.sort_by(|a, b| a.0 .1.total_cmp(&b.0 .1));
    tagged.into_iter().unzip()
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

/// Up to 30 s of one track's speech for the detection: the pieces the pass
/// transcribes with the most energy (sum of squared samples), joined in time
/// order; the last piece chosen gives only what is left of the 30 s.
///
/// Why energy, not length: the microphone's lenient VAD thresholds (0.20 /
/// 0.10) accept long stretches of fan, keyboard or breathing, and without the
/// continuous-speech cap such a stretch can be the track's longest piece.
/// Whisper's language identification on noise is unreliable, and a confident
/// wrong answer would fix the whole track's language. Energy grows with the
/// square of the level, so a stretch five times quieter than the speech has to
/// be 25 times longer to be chosen.
pub fn detection_audio<'a>(segments: impl IntoIterator<Item = &'a SpeechSegment>) -> Vec<f32> {
    let mut candidates: Vec<(f32, &SpeechSegment)> = segments
        .into_iter()
        .filter(|s| skip_reason(&s.samples).is_none())
        .map(|s| (s.samples.iter().map(|x| x * x).sum::<f32>(), s))
        .collect();
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut chosen: Vec<(&SpeechSegment, usize)> = Vec::new();
    let mut total = 0;
    for (_, segment) in candidates {
        if total >= DETECTION_SAMPLES {
            break;
        }
        let take = segment.samples.len().min(DETECTION_SAMPLES - total);
        total += take;
        chosen.push((segment, take));
    }
    chosen.sort_by(|a, b| a.0.start_timestamp_ms.total_cmp(&b.0.start_timestamp_ms));
    chosen.iter().flat_map(|(segment, take)| segment.samples[..*take].iter().copied()).collect()
}

/// Whether a detection is confident enough to fix a track's language.
fn confident(probability: f32) -> bool {
    probability > MIN_TRACK_LANGUAGE_PROBABILITY
}

/// The track's language from the detections on the two halves of its
/// detection audio: only when both are confident and agree. One detection
/// judges one stretch, and the loudest stretch of a track is not always its
/// speech (music or a shared video on the system track, a quote in another
/// language); a confident misreading there would fix the whole track. Two
/// halves that agree make that one stretch outvoted. Limit: a track whose
/// chosen 30 s are all the same non-speech or foreign material can still
/// agree on a wrong language.
fn agreed_language(first: &Option<(String, f32)>, second: &Option<(String, f32)>) -> Option<String> {
    match (first, second) {
        (Some((a, p)), Some((b, q))) if a == b && confident(*p) && confident(*q) => Some(a.clone()),
        _ => None,
    }
}

fn describe(detection: &Option<(String, f32)>) -> String {
    match detection {
        Some((language, probability)) => format!("{language} (p = {probability:.2})"),
        None => "no language".to_string(),
    }
}

/// The language of one track's pieces, or `None` when the track keeps per-call
/// detection (no speech, a failed detection, or halves that do not agree; see
/// [`agreed_language`]). Two encoder passes, one per half.
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
    let (first_half, second_half) = audio.split_at(audio.len() / 2);
    let detections = match engine.detect_language_with_probability(first_half).await {
        Ok(first) => engine.detect_language_with_probability(second_half).await.map(|second| (first, second)),
        Err(error) => Err(error),
    };
    match detections {
        Ok((first, second)) => match agreed_language(&first, &second) {
            Some(language) => {
                info!(
                    "Detected language {} and {} on two halves of {seconds:.1}s of speech for {track:?}",
                    describe(&first),
                    describe(&second)
                );
                Some(language)
            }
            None => {
                warn!(
                    "Language detection gave {} and {} on two halves of {seconds:.1}s of speech for {track:?}; \
                     detecting per piece",
                    describe(&first),
                    describe(&second)
                );
                None
            }
        },
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
    fn three_or_more_repeated_rows_of_a_piece_merge_into_one() {
        let piece = segment(0.0, 20.0, 0.1);
        let rows = rows_from_piece(
            &piece,
            vec![
                timed(0.0, 2_000.0, "Да."),
                timed(2_000.0, 3_000.0, "да"),
                timed(3_000.0, 4_500.0, "Да!"),
                timed(4_500.0, 8_000.0, "Хорошо, договорились."),
                timed(8_000.0, 9_000.0, "Нет."),
                timed(9_000.0, 10_000.0, "Нет."),
            ],
        );
        assert_eq!(
            rows,
            vec![
                ("Да.".to_string(), 0.0, 4_500.0),
                ("Хорошо, договорились.".to_string(), 4_500.0, 8_000.0),
                // Two answers in a row stay two rows.
                ("Нет.".to_string(), 8_000.0, 9_000.0),
                ("Нет.".to_string(), 9_000.0, 10_000.0),
            ]
        );
    }

    #[test]
    fn a_loop_of_segments_without_duration_leaves_one_repeat() {
        let piece = segment(0.0, 10.0, 0.1);
        let mut segments = vec![timed(0.0, 4_000.0, "Хорошо."), timed(4_000.0, 4_000.0, "Да.")];
        // The loop goes on at the piece's end and past it.
        segments.extend((0..6).map(|i| timed(10_000.0 + i as f64 * 500.0, 10_500.0 + i as f64 * 500.0, "Да.")));
        assert_eq!(rows_from_piece(&piece, segments), vec![("Хорошо. Да.".to_string(), 0.0, 4_000.0)]);
    }

    #[test]
    fn rows_of_two_tracks_are_put_in_time_order_with_their_hints() {
        // A 25 s microphone piece from 0 s, then a system piece from 3 s.
        let rows = vec![
            ("a".to_string(), 0.0, 5_000.0),
            ("b".to_string(), 5_000.0, 12_000.0),
            ("c".to_string(), 12_000.0, 25_000.0),
            ("d".to_string(), 3_000.0, 9_000.0),
            ("e".to_string(), 12_000.0, 14_000.0),
        ];
        let hints = vec!["You", "You", "You", "Guest", "Guest"];
        let (rows, hints) = in_time_order(rows, hints);
        let texts: Vec<&str> = rows.iter().map(|(text, _, _)| text.as_str()).collect();
        assert_eq!(texts, ["a", "d", "b", "c", "e"]);
        assert_eq!(hints, ["You", "Guest", "You", "You", "Guest"]);
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
    fn a_track_language_needs_two_confident_halves_that_agree() {
        let detected = |language: &str, p: f32| Some((language.to_string(), p));
        assert_eq!(agreed_language(&detected("ru", 0.99), &detected("ru", 0.8)), Some("ru".to_string()));
        assert_eq!(agreed_language(&detected("ru", 0.99), &detected("en", 0.97)), None);
        assert_eq!(agreed_language(&detected("ru", 0.99), &detected("ru", 0.5)), None);
        assert_eq!(agreed_language(&detected("ru", 0.45), &detected("ru", 0.99)), None);
        assert_eq!(agreed_language(&detected("ru", 0.99), &None), None);
    }

    #[test]
    fn detection_prefers_speech_to_a_longer_quiet_stretch() {
        // A 25 s stretch of quiet noise first, then 32 s of speech in 8 s pieces.
        let segments = [
            segment(0.0, 25.0, 0.02),
            segment(30.0, 8.0, 0.2),
            segment(40.0, 8.0, 0.2),
            segment(50.0, 8.0, 0.2),
            segment(60.0, 8.0, 0.2),
        ];
        let audio = detection_audio(&segments);
        assert_eq!(audio.len(), DETECTION_SAMPLES);
        assert!(audio.iter().all(|&x| x == 0.2));
    }

    #[test]
    fn detection_joins_the_chosen_pieces_in_time_order() {
        // By energy: the 20 s piece, the 8 s piece, then 2 s of the 6 s piece.
        let segments = [segment(0.0, 6.0, 0.1), segment(10.0, 20.0, 0.5), segment(40.0, 8.0, 0.3)];
        let audio = detection_audio(&segments);
        assert_eq!(audio.len(), DETECTION_SAMPLES);
        assert_eq!(audio[0], 0.1);
        assert_eq!(audio[2 * 16_000 - 1], 0.1);
        assert_eq!(audio[2 * 16_000], 0.5);
        assert_eq!(audio[22 * 16_000], 0.3);
        assert_eq!(audio[DETECTION_SAMPLES - 1], 0.3);
    }

    #[test]
    fn detection_skips_what_the_pass_skips() {
        let segments = [segment(0.0, 20.0, 0.001), segment(30.0, 0.05, 0.5), segment(40.0, 3.0, 0.5)];
        let audio = detection_audio(&segments);
        assert_eq!(audio.len(), 3 * 16_000);
        assert!(detection_audio(&segments[..2]).is_empty());
    }
}
