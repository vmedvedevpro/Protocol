//! The live worker's Parakeet windows on the NPU (#66): one
//! [`chunking::Live`] per capture source, owned by the worker for the
//! recording (one worker: `NUM_WORKERS` is 1, so a source's pieces reach it in
//! order), and the rows of words a source held at a cap cut that no
//! continuation joined.
//!
//! Such words are shown in a row of their own, with their own time and the
//! label of the piece they were held from, never at the start of a later,
//! unrelated row: when the source's next piece does not continue the stretch,
//! when the recording has gone on [`HELD_WAIT`] past them without any piece
//! waiting for the worker, and at the end of the recording.
//!
//! The wait is measured on the source's audio, not from when the worker got
//! to the held piece, and only an empty queue waits ([`next`]): a worker that
//! lags still has the continuation in its queue, and it must join the held
//! words, not follow them. Where the source's audio is: the end of its newest
//! piece received, plus the time since it was received. Capture runs in real
//! time, so that is never ahead of the recording.

use std::time::{Duration, Instant};

use tokio::sync::mpsc::error::TryRecvError;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::audio::recording_state::DeviceType;
use crate::parakeet_engine::chunking::{self, Held, Live};

/// How far the recording goes past held words before they are shown on
/// their own. After a cap cut the VAD keeps the speech and sends it at its
/// next pause (800 ms of redemption) or its next cap (6 s), so the
/// continuation ends within 6.8 s of the cut unless it was dropped (digital
/// silence, under 800 samples, a capture restart).
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
    /// Where in the source's audio (ms) the held words stop waiting.
    held_until_ms: Option<f64>,
    /// The end (ms) of the source's newest piece received, and when.
    newest: Option<(f64, Instant)>,
}

impl Source {
    /// When the source's audio, as far as the worker can tell, reaches
    /// `held_until_ms`.
    fn deadline(&self) -> Option<Instant> {
        let (newest, at) = self.newest?;
        Some(at + Duration::from_secs_f64(((self.held_until_ms? - newest) / 1000.0).max(0.0)))
    }
}

#[derive(Debug, Default)]
pub struct ParakeetLive {
    sources: [Source; 2],
}

/// What a wait for the next piece gave.
#[derive(Debug, PartialEq)]
pub enum Received<T> {
    /// A piece, or `None` once the channel is closed and empty.
    Piece(Option<T>),
    /// The deadline passed with no piece waiting.
    Waited,
}

/// The next piece of the worker's queue: one already queued comes at once,
/// whatever the deadline; only an empty queue waits, until `deadline`.
pub async fn next<T>(receiver: &mut UnboundedReceiver<T>, deadline: Option<Instant>) -> Received<T> {
    let Some(deadline) = deadline else { return Received::Piece(receiver.recv().await) };
    match receiver.try_recv() {
        Ok(piece) => Received::Piece(Some(piece)),
        Err(TryRecvError::Disconnected) => Received::Piece(None),
        Err(TryRecvError::Empty) => match tokio::time::timeout_at(deadline.into(), receiver.recv()).await {
            Ok(piece) => Received::Piece(piece),
            Err(_) => Received::Waited,
        },
    }
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

    /// A piece of source `index` ending at `end_ms` was received at `now`.
    pub fn seen(&mut self, index: usize, end_ms: f64, now: Instant) {
        let newest = &mut self.sources[index].newest;
        if newest.map_or(true, |(newest, _)| end_ms > newest) {
            *newest = Some((end_ms, now));
        }
    }

    /// Before the piece at `start_ms` of source `index`: the words its
    /// stretch still holds, when the piece does not continue it.
    pub fn before_piece(&mut self, index: usize, start_ms: f64) -> Option<HeldRow> {
        let source = &mut self.sources[index];
        if source.live.continues(start_ms) {
            return None;
        }
        source.held_until_ms = None;
        let held = source.live.flush()?;
        Some(row(held, index, source.label.as_deref()))
    }

    /// After a piece of source `index` labelled `label`: whether its words
    /// now wait, and until where in its audio.
    pub fn after_piece(&mut self, index: usize, label: &str) {
        let source = &mut self.sources[index];
        source.label = Some(label.to_string());
        source.held_until_ms = source.live.held_end_ms().map(|end| end + HELD_WAIT.as_secs_f64() * 1000.0);
    }

    /// When, waiting for the next piece, the first held words stop waiting.
    pub fn deadline(&self) -> Option<Instant> {
        self.sources.iter().filter_map(Source::deadline).min()
    }

    /// The rows of held words whose source's audio has gone past their wait
    /// by `now`; call it only when a wait for the next piece ended without
    /// one. The stretch stays, so a continuation that comes after all still
    /// joins it.
    pub fn overdue(&mut self, now: Instant) -> Vec<HeldRow> {
        let mut rows = Vec::new();
        for (index, source) in self.sources.iter_mut().enumerate() {
            if source.deadline().is_some_and(|deadline| deadline <= now) {
                source.held_until_ms = None;
                rows.extend(source.live.release().map(|held| row(held, index, source.label.as_deref())));
            }
        }
        rows
    }

    /// The rows of what is still held at the end of the recording.
    pub fn finish(&mut self) -> Vec<HeldRow> {
        let mut rows = Vec::new();
        for (index, source) in self.sources.iter_mut().enumerate() {
            source.held_until_ms = None;
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

    /// A capped 6 s piece of source `index` at `start_ms`, received at `now`,
    /// whose last word, "конец" 0.4 s before its end, is held.
    fn capped(live: &mut ParakeetLive, index: usize, start_ms: f64, label: &str, now: Instant) {
        let samples = vec![0.1f32; 6000 * 16];
        live.seen(index, start_ms + 6000.0, now);
        live.live(index)
            .piece(start_ms, &samples, true, |_: &[f32], offset| -> Result<Vec<Word>, ()> {
                Ok(vec![Word::new(offset + 1000.0, " начало"), Word::new(offset + 5600.0, " конец")])
            })
            .unwrap();
        live.after_piece(index, label);
    }

    /// The system source's 2 s piece at 66 s that continues `capped`'s
    /// stretch at 60 s and hears its cut word whole: what it shows.
    fn continuation(live: &mut ParakeetLive, now: Instant) -> String {
        live.seen(1, 68_000.0, now);
        assert_eq!(live.before_piece(1, 66_000.0), None);
        let samples = vec![0.1f32; 2000 * 16];
        let shown = live
            .live(1)
            .piece(66_000.0, &samples, false, |_: &[f32], _| -> Result<Vec<Word>, ()> {
                Ok(vec![Word::new(65_600.0, " концерт"), Word::new(67_000.0, " дальше")])
            })
            .unwrap();
        live.after_piece(1, "Speaker 2");
        chunking::text(&shown)
    }

    #[test]
    fn held_words_wait_a_bounded_time_and_then_come_on_their_own() {
        let mut live = ParakeetLive::default();
        let at = Instant::now();
        assert_eq!(live.deadline(), None);
        capped(&mut live, 1, 60_000.0, "Speaker 2", at);
        assert_eq!(live.deadline(), Some(at + HELD_WAIT));
        assert!(live.overdue(at + HELD_WAIT - Duration::from_millis(5)).is_empty());

        let rows = live.overdue(at + HELD_WAIT);
        assert_eq!(rows, vec![HeldRow { source: "Speaker 2".to_string(), text: "конец".to_string(), start_s: 65.6, end_s: 66.0 }]);
        assert_eq!(live.deadline(), None);
        assert!(live.overdue(at + HELD_WAIT * 2).is_empty() && live.finish().is_empty());
    }

    #[test]
    fn the_wait_runs_on_the_sources_own_audio() {
        let mut live = ParakeetLive::default();
        let at = Instant::now();
        capped(&mut live, 1, 60_000.0, "Speaker 2", at);
        // The microphone's pieces say nothing of where the system audio is.
        live.seen(0, 75_000.0, at + Duration::from_secs(1));
        assert_eq!(live.deadline(), Some(at + HELD_WAIT));
        // A system piece that came 3 s on and ended at 68 s puts the source's
        // audio there: the held words, waiting until 74 s, are due 6 s after.
        live.seen(1, 68_000.0, at + Duration::from_secs(3));
        assert_eq!(live.deadline(), Some(at + Duration::from_secs(9)));
    }

    #[tokio::test]
    async fn a_lagging_worker_takes_the_queued_continuation_before_releasing_held_words() {
        let mut live = ParakeetLive::default();
        // The worker got the capped piece 9 s ago and is still behind: by the
        // clock its deadline has passed, and the continuation waits in the queue.
        let at = Instant::now() - Duration::from_secs(9);
        capped(&mut live, 1, 60_000.0, "Speaker 2", at);
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        sender.send("continuation").unwrap();
        assert!(live.deadline().unwrap() < Instant::now());

        assert_eq!(next(&mut receiver, live.deadline()).await, Received::Piece(Some("continuation")));
        // It joins the held words, and the word it heard whole replaces the
        // cut one; nothing is left to release.
        assert_eq!(continuation(&mut live, Instant::now()), "концерт дальше");
        assert_eq!(live.deadline(), None);
        assert!(live.overdue(Instant::now()).is_empty() && live.finish().is_empty());
    }

    #[tokio::test]
    async fn a_queued_piece_comes_before_any_deadline_and_only_an_empty_queue_waits() {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let past = Instant::now() - Duration::from_secs(1);
        sender.send(1).unwrap();
        sender.send(2).unwrap();
        assert_eq!(next(&mut receiver, Some(past)).await, Received::Piece(Some(1)));
        assert_eq!(next(&mut receiver, Some(past)).await, Received::Piece(Some(2)));
        assert_eq!(next(&mut receiver, Some(past)).await, Received::Waited);
        let soon = Instant::now() + Duration::from_millis(20);
        assert_eq!(next(&mut receiver, Some(soon)).await, Received::Waited);
        sender.send(3).unwrap();
        assert_eq!(next(&mut receiver, None).await, Received::Piece(Some(3)));
        drop(sender);
        assert_eq!(next(&mut receiver, Some(past)).await, Received::Piece(None));
    }

    #[test]
    fn a_piece_that_does_not_continue_gets_the_held_words_as_an_earlier_row() {
        let mut live = ParakeetLive::default();
        let at = Instant::now();
        capped(&mut live, 0, 0.0, "You", at);
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
        capped(&mut live, 0, 0.0, "You", at);
        let samples = vec![0.1f32; 6000 * 16];
        // No row of the system source was labelled: someone else, not the user.
        live.live(1)
            .piece(0.0, &samples, true, |_: &[f32], offset| -> Result<Vec<Word>, ()> { Ok(vec![Word::new(offset + 5600.0, " конец")]) })
            .unwrap();
        let rows = live.finish();
        let labels: Vec<&str> = rows.iter().map(|row| row.source.as_str()).collect();
        assert_eq!(labels, vec!["You", "Guest"]);
        assert!(live.finish().is_empty());
    }
}
