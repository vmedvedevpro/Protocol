//! The live worker's Parakeet windows on the NPU (#66): one
//! [`chunking::Live`] per capture source, owned by the worker for the
//! recording (one worker: `NUM_WORKERS` is 1, so a source's pieces reach it in
//! order), and the rows of words a source held at a cap cut that no
//! continuation joined.
//!
//! Such words are shown in a row of their own, with their own time and the
//! label of the piece they were held from, never at the start of a later,
//! unrelated row: when the source's next piece does not continue the stretch,
//! when [`HELD_WAIT`] passes without it, and at the end of the recording.

use std::time::{Duration, Instant};

use crate::audio::recording_state::DeviceType;
use crate::parakeet_engine::chunking::{self, Held, Live};

/// How long held words wait for their continuation while no piece comes.
/// After a cap cut the VAD keeps the speech and sends it at its next pause
/// (800 ms of redemption) or its next cap (6 s), both in real time, so the
/// continuation reaches the worker within 6.8 s of the cut unless it was
/// dropped (digital silence, under 800 samples, a capture restart).
pub const HELD_WAIT: Duration = Duration::from_secs(8);

/// A row of held words: `start_s` and `end_s` are recording-relative.
#[derive(Debug, Clone, PartialEq)]
pub struct HeldRow {
    pub source: String,
    pub text: String,
    pub start_s: f64,
    pub end_s: f64,
}

#[derive(Debug, Default)]
struct Source {
    live: Live,
    /// The label of the source's last piece: the one its held words are from.
    label: Option<String>,
    /// When the last piece left words held.
    held_since: Option<Instant>,
}

#[derive(Debug, Default)]
pub struct ParakeetLive {
    sources: [Source; 2],
}

impl ParakeetLive {
    /// The windows' index of a capture source.
    pub fn index(device: &DeviceType) -> usize {
        match device {
            DeviceType::System => 1,
            _ => 0,
        }
    }

    /// The source's windows, for its next piece's call.
    pub fn live(&mut self, index: usize) -> &mut Live {
        &mut self.sources[index].live
    }

    /// Before the piece at `start_ms` of source `index`: the words its
    /// stretch still holds, when the piece does not continue it.
    pub fn before_piece(&mut self, index: usize, start_ms: f64) -> Option<HeldRow> {
        let source = &mut self.sources[index];
        if source.live.continues(start_ms) {
            return None;
        }
        source.held_since = None;
        let held = source.live.flush()?;
        Some(row(held, index, source.label.as_deref()))
    }

    /// After a piece of source `index` labelled `label`: whether its words
    /// now wait, and since when.
    pub fn after_piece(&mut self, index: usize, label: &str, now: Instant) {
        let source = &mut self.sources[index];
        source.label = Some(label.to_string());
        source.held_since = source.live.holds().then_some(now);
    }

    /// When the first held words stop waiting.
    pub fn deadline(&self) -> Option<Instant> {
        self.sources.iter().filter_map(|source| source.held_since).min().map(|since| since + HELD_WAIT)
    }

    /// The rows of held words whose wait has passed at `now`; the stretch
    /// stays, so a continuation that comes after all still joins it.
    pub fn overdue(&mut self, now: Instant) -> Vec<HeldRow> {
        let mut rows = Vec::new();
        for (index, source) in self.sources.iter_mut().enumerate() {
            if source.held_since.is_some_and(|since| now >= since + HELD_WAIT) {
                source.held_since = None;
                rows.extend(source.live.release().map(|held| row(held, index, source.label.as_deref())));
            }
        }
        rows
    }

    /// The rows of what is still held at the end of the recording.
    pub fn finish(&mut self) -> Vec<HeldRow> {
        let mut rows = Vec::new();
        for (index, source) in self.sources.iter_mut().enumerate() {
            source.held_since = None;
            rows.extend(source.live.flush().map(|held| row(held, index, source.label.as_deref())));
        }
        rows
    }
}

/// The row of `held` from source `index`: from its first word to the end of
/// its stretch, under the label of the piece it was held from, else the
/// worker's label for the source (the microphone is the user, the system
/// audio someone else).
fn row(held: Held, index: usize, label: Option<&str>) -> HeldRow {
    let end_s = held.end_ms / 1000.0;
    let start_s = held.words.first().map_or(end_s, |word| (word.start_ms / 1000.0).min(end_s));
    let fallback = if index == 1 { "Guest" } else { "You" };
    HeldRow { source: label.unwrap_or(fallback).to_string(), text: chunking::text(&held.words), start_s, end_s }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parakeet_engine::chunking::Word;

    /// A capped 6 s piece of source `index` at `start_ms` whose last word,
    /// "конец" 0.4 s before its end, is held.
    fn capped(live: &mut ParakeetLive, index: usize, start_ms: f64) {
        let samples = vec![0.1f32; 6000 * 16];
        live.live(index)
            .piece(start_ms, &samples, true, |_: &[f32], offset| -> Result<Vec<Word>, ()> {
                Ok(vec![Word::new(offset + 1000.0, " начало"), Word::new(offset + 5600.0, " конец")])
            })
            .unwrap();
    }

    #[test]
    fn held_words_wait_a_bounded_time_and_then_come_on_their_own() {
        let mut live = ParakeetLive::default();
        let at = Instant::now();
        assert_eq!(live.deadline(), None);
        capped(&mut live, 1, 60_000.0);
        live.after_piece(1, "Speaker 2", at);
        assert_eq!(live.deadline(), Some(at + HELD_WAIT));
        assert!(live.overdue(at + HELD_WAIT - Duration::from_millis(1)).is_empty());

        let rows = live.overdue(at + HELD_WAIT);
        assert_eq!(rows, vec![HeldRow { source: "Speaker 2".to_string(), text: "конец".to_string(), start_s: 65.6, end_s: 66.0 }]);
        assert_eq!(live.deadline(), None);
        assert!(live.overdue(at + HELD_WAIT * 2).is_empty() && live.finish().is_empty());
    }

    #[test]
    fn a_piece_that_does_not_continue_gets_the_held_words_as_an_earlier_row() {
        let mut live = ParakeetLive::default();
        let at = Instant::now();
        capped(&mut live, 0, 0.0);
        live.after_piece(0, "You", at);
        // The continuation was dropped; the next piece starts 4 s later.
        assert_eq!(live.before_piece(0, 6000.0), None);
        let row = live.before_piece(0, 10_000.0).unwrap();
        assert_eq!((row.text.as_str(), row.start_s, row.end_s), ("конец", 5.6, 6.0));
        assert_eq!(live.deadline(), None);
    }

    #[test]
    fn the_end_of_the_recording_shows_each_sources_held_words_under_its_label() {
        let mut live = ParakeetLive::default();
        let at = Instant::now();
        capped(&mut live, 0, 0.0);
        capped(&mut live, 1, 0.0);
        // No row of the system source was labelled yet: someone else, not the user.
        live.after_piece(0, "You", at);
        let rows = live.finish();
        let labels: Vec<&str> = rows.iter().map(|row| row.source.as_str()).collect();
        assert_eq!(labels, vec!["You", "Guest"]);
        assert!(live.finish().is_empty());
    }
}
