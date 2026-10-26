//! The meeting save that follows a native Stop.
//!
//! Native Stop drains transcription and writes the audio files, then hands the
//! meeting to the main window with `recording-stop-complete`; the WebView saves
//! the meeting and transcript rows (`useRecordingStop.ts`). Native code cannot
//! see that save, so each handoff gets an id here: [`begin`] right before the
//! event is sent, [`finish`] when the WebView reports how its save ended
//! through [`recording_save_finished`]. The updater's busy registry reads
//! [`pending`].
//!
//! Only the latest handoff is tracked: one recording runs at a time, and the
//! WebView handles one stop at a time. A WebView that never answers (reloaded
//! or crashed) holds nothing up for longer than [`ANSWER_WINDOW`].

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// How long a handoff counts as pending without an answer. The save usually
/// ends a few seconds after the event: the WebView waits 4.5 s for late
/// transcript events and then writes the meeting in one call.
pub const ANSWER_WINDOW: Duration = Duration::from_secs(120);

/// How the WebView's save ended. Serialized in camelCase for the WebView.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveOutcome {
    /// The meeting and its transcript are in the database.
    Saved,
    /// A take under 10 seconds, discarded as on every Stop.
    Discarded,
    /// The WebView skipped the save because transcription did not settle.
    NotSaved,
    /// The save failed; the WebView showed the error.
    Failed,
}

/// Where a handoff stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handoff {
    Pending,
    Finished(SaveOutcome),
    /// No answer within [`ANSWER_WINDOW`].
    Unanswered,
    /// No Stop has handed a meeting over yet.
    NoStop,
}

/// The latest handoff (pure, for tests).
#[derive(Debug)]
pub(crate) struct Handoffs {
    /// Id of the latest handoff; 0 before the first.
    latest: u64,
    begun: Option<Instant>,
    outcome: Option<SaveOutcome>,
}

impl Handoffs {
    pub(crate) const fn new() -> Self {
        Self {
            latest: 0,
            begun: None,
            outcome: None,
        }
    }

    pub(crate) fn begin(&mut self, now: Instant) -> u64 {
        self.latest += 1;
        self.begun = Some(now);
        self.outcome = None;
        self.latest
    }

    /// Records the answer for `id`. An answer for an older handoff, or a
    /// second answer, changes nothing. A late answer still counts: the
    /// meeting was saved even if a quit stopped waiting for it.
    pub(crate) fn finish(&mut self, id: u64, outcome: SaveOutcome) -> bool {
        if id == 0 || id != self.latest || self.outcome.is_some() {
            return false;
        }
        self.outcome = Some(outcome);
        true
    }

    pub(crate) fn latest(&self, now: Instant) -> Handoff {
        match (self.begun, self.outcome) {
            (None, _) => Handoff::NoStop,
            (Some(_), Some(outcome)) => Handoff::Finished(outcome),
            (Some(begun), None) if now.saturating_duration_since(begun) < ANSWER_WINDOW => Handoff::Pending,
            (Some(_), None) => Handoff::Unanswered,
        }
    }
}

static HANDOFFS: Mutex<Handoffs> = Mutex::new(Handoffs::new());

fn handoffs() -> MutexGuard<'static, Handoffs> {
    HANDOFFS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Starts a handoff; its id travels in `recording-stop-complete`.
pub fn begin() -> u64 {
    handoffs().begin(Instant::now())
}

pub fn finish(id: u64, outcome: SaveOutcome) -> bool {
    handoffs().finish(id, outcome)
}

pub fn latest() -> Handoff {
    handoffs().latest(Instant::now())
}

/// The main window is saving the meeting of the last Stop.
pub fn pending() -> bool {
    latest() == Handoff::Pending
}

/// The main window's answer: how the save after Stop `stop_id` ended.
#[tauri::command]
pub fn recording_save_finished(stop_id: u64, outcome: SaveOutcome) {
    if finish(stop_id, outcome) {
        log::info!("[save] meeting save after stop {stop_id}: {outcome:?}");
        // The answer ends the save; a lease report still in flight must not
        // keep an update from installing.
        crate::updater::busy::end_ui_activity(crate::updater::busy::UiActivity::RecordingSave);
    } else {
        log::warn!("[save] ignored an answer for stop {stop_id} ({outcome:?}): not the latest stop");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handoff_is_pending_until_the_webview_answers() {
        let start = Instant::now();
        let mut handoffs = Handoffs::new();
        assert_eq!(handoffs.latest(start), Handoff::NoStop);

        let id = handoffs.begin(start);
        assert_eq!(handoffs.latest(start + Duration::from_secs(5)), Handoff::Pending);
        assert!(handoffs.finish(id, SaveOutcome::Saved));
        assert_eq!(handoffs.latest(start + Duration::from_secs(6)), Handoff::Finished(SaveOutcome::Saved));

        assert!(!handoffs.finish(id, SaveOutcome::Failed), "a second answer changes nothing");
        assert_eq!(handoffs.latest(start), Handoff::Finished(SaveOutcome::Saved));
    }

    #[test]
    fn an_answer_for_an_older_stop_is_ignored() {
        let start = Instant::now();
        let mut handoffs = Handoffs::new();
        let first = handoffs.begin(start);
        let second = handoffs.begin(start);
        assert!(!handoffs.finish(first, SaveOutcome::Saved));
        assert!(!handoffs.finish(0, SaveOutcome::Saved));
        assert_eq!(handoffs.latest(start), Handoff::Pending);
        assert!(handoffs.finish(second, SaveOutcome::Discarded));
        assert_eq!(handoffs.latest(start), Handoff::Finished(SaveOutcome::Discarded));
    }

    #[test]
    fn a_silent_webview_holds_nothing_up_past_the_window() {
        let start = Instant::now();
        let mut handoffs = Handoffs::new();
        let id = handoffs.begin(start);
        assert_eq!(handoffs.latest(start + ANSWER_WINDOW - Duration::from_millis(1)), Handoff::Pending);
        assert_eq!(handoffs.latest(start + ANSWER_WINDOW), Handoff::Unanswered);

        assert!(handoffs.finish(id, SaveOutcome::Saved), "a late answer is still recorded");
        assert_eq!(handoffs.latest(start + ANSWER_WINDOW), Handoff::Finished(SaveOutcome::Saved));
    }

    #[test]
    fn outcomes_use_the_webview_names() {
        for (name, outcome) in [
            ("saved", SaveOutcome::Saved),
            ("discarded", SaveOutcome::Discarded),
            ("notSaved", SaveOutcome::NotSaved),
            ("failed", SaveOutcome::Failed),
        ] {
            assert_eq!(serde_json::from_str::<SaveOutcome>(&format!("\"{name}\"")).unwrap(), outcome);
        }
    }
}
