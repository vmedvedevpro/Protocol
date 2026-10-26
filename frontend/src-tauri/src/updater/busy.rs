//! What an update must not interrupt.
//!
//! The updater restarts or quits the app only when [`current`] is empty, and the
//! install gate (`install.rs`) checks it again under the engine lifecycle lock.
//! Each reason is read from the module that owns the work:
//!
//! - work that already has a flag of its own (recording, its stop drain, audio
//!   import, retranscription) and summary runs (their cancellation registry) are
//!   read through a getter in that module;
//! - work without such a flag holds a [`BusyGuard`] from [`hold`] for as long as
//!   it runs (offline speaker identification, model downloads).
//!
//! A new long-running operation must do one of the two, or an update can restart
//! the app in the middle of it.
//!
//! Two windows of work are visible only to the frontend: saving the meeting after
//! a recording stops (native `IS_RECORDING` is already false) and the post-call
//! pipeline between its native steps. The WebView reports them as a lease:
//! [`set_ui_activity`] replaces the whole set, and the set expires [`UI_LEASE`]
//! after the last report, so a reloaded or crashed WebView cannot block updates
//! forever. The frontend only reports; this module decides.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Why the app cannot restart now. Serialized in camelCase; the frontend owns
/// the sentence for each reason. The order is the order of importance: the UI
/// explains the first one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BusyReason {
    Recording,
    RecordingStopping,
    RecordingSave,
    Import,
    Retranscription,
    Diarization,
    Summary,
    PostCall,
    ModelDownload,
    Onboarding,
    /// Only from the install gate: the engine lifecycle lock stayed taken.
    SpeechEngine,
}

impl BusyReason {
    const ALL: [BusyReason; 11] = [
        BusyReason::Recording,
        BusyReason::RecordingStopping,
        BusyReason::RecordingSave,
        BusyReason::Import,
        BusyReason::Retranscription,
        BusyReason::Diarization,
        BusyReason::Summary,
        BusyReason::PostCall,
        BusyReason::ModelDownload,
        BusyReason::Onboarding,
        BusyReason::SpeechEngine,
    ];
}

/// Work the frontend reports (see the module comment).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UiActivity {
    RecordingSave,
    PostCall,
}

impl UiActivity {
    fn reason(self) -> BusyReason {
        match self {
            UiActivity::RecordingSave => BusyReason::RecordingSave,
            UiActivity::PostCall => BusyReason::PostCall,
        }
    }
}

/// How long a UI report stays valid. The frontend renews it every 60 s while
/// the set is not empty.
pub const UI_LEASE: Duration = Duration::from_secs(150);

#[allow(clippy::declare_interior_mutable_const)]
const NOT_HELD: AtomicUsize = AtomicUsize::new(0);
/// Live guards per reason, indexed like `BusyReason::ALL`.
static HELD: [AtomicUsize; BusyReason::ALL.len()] = [NOT_HELD; BusyReason::ALL.len()];

/// False until the updater has read the onboarding status (and while setup is
/// unfinished), so an unknown state blocks installs.
static ONBOARDING_COMPLETE: AtomicBool = AtomicBool::new(false);

static UI: Mutex<UiLease> = Mutex::new(UiLease::new());

fn slot(reason: BusyReason) -> &'static AtomicUsize {
    let index = BusyReason::ALL
        .iter()
        .position(|candidate| *candidate == reason)
        .expect("every reason is listed in BusyReason::ALL");
    &HELD[index]
}

/// Marks `reason` as busy until the returned guard is dropped. Hold it for the
/// whole operation, including the part that runs after the command returns.
#[must_use = "the reason is busy only while the guard lives"]
pub fn hold(reason: BusyReason) -> BusyGuard {
    slot(reason).fetch_add(1, Ordering::SeqCst);
    BusyGuard { reason }
}

pub struct BusyGuard {
    reason: BusyReason,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        slot(self.reason).fetch_sub(1, Ordering::SeqCst);
    }
}

fn held(reason: BusyReason) -> bool {
    slot(reason).load(Ordering::SeqCst) > 0
}

pub fn set_onboarding_complete(complete: bool) {
    ONBOARDING_COMPLETE.store(complete, Ordering::SeqCst);
}

pub fn onboarding_complete() -> bool {
    ONBOARDING_COMPLETE.load(Ordering::SeqCst)
}

/// Replaces the frontend's activity set and renews its lease.
pub fn set_ui_activity(activities: Vec<UiActivity>) {
    if let Ok(mut lease) = UI.lock() {
        lease.replace(activities, Instant::now());
    }
}

fn ui_activity() -> Vec<UiActivity> {
    UI.lock()
        .map(|lease| lease.active(Instant::now()).to_vec())
        .unwrap_or_default()
}

/// Everything that is busy right now, most important first. Cheap: atomics and
/// two short mutexes, so it can run on every status push and in menu code.
pub fn current() -> Vec<BusyReason> {
    let sources = Sources {
        recording: crate::audio::recording_commands::is_recording_active(),
        stopping: crate::audio::recording_commands::is_stopping(),
        import: crate::audio::import::is_import_in_progress(),
        retranscription: crate::audio::retranscription::is_retranscription_in_progress(),
        summaries: crate::summary::service::active_summary_count(),
        onboarding_complete: onboarding_complete(),
    };
    reasons(&sources, held, &ui_activity())
}

/// Owner flags read by [`current`]; separate so the combination is testable.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Sources {
    pub recording: bool,
    pub stopping: bool,
    pub import: bool,
    pub retranscription: bool,
    pub summaries: usize,
    pub onboarding_complete: bool,
}

pub(crate) fn reasons(
    sources: &Sources,
    held: impl Fn(BusyReason) -> bool,
    ui: &[UiActivity],
) -> Vec<BusyReason> {
    BusyReason::ALL
        .into_iter()
        .filter(|reason| {
            held(*reason)
                || ui.iter().any(|activity| activity.reason() == *reason)
                || match reason {
                    BusyReason::Recording => sources.recording,
                    BusyReason::RecordingStopping => sources.stopping,
                    BusyReason::Import => sources.import,
                    BusyReason::Retranscription => sources.retranscription,
                    BusyReason::Summary => sources.summaries > 0,
                    BusyReason::Onboarding => !sources.onboarding_complete,
                    _ => false,
                }
        })
        .collect()
}

/// The frontend's last report and when it was made.
pub(crate) struct UiLease {
    activities: Vec<UiActivity>,
    renewed: Option<Instant>,
}

impl UiLease {
    pub(crate) const fn new() -> Self {
        Self {
            activities: Vec::new(),
            renewed: None,
        }
    }

    pub(crate) fn replace(&mut self, activities: Vec<UiActivity>, now: Instant) {
        self.activities = activities;
        self.renewed = Some(now);
    }

    pub(crate) fn active(&self, now: Instant) -> &[UiActivity] {
        match self.renewed {
            Some(renewed) if now.saturating_duration_since(renewed) < UI_LEASE => &self.activities,
            _ => &[],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle() -> Sources {
        Sources {
            onboarding_complete: true,
            ..Sources::default()
        }
    }

    #[test]
    fn nothing_is_busy_after_setup_with_no_work() {
        assert!(reasons(&idle(), |_| false, &[]).is_empty());
    }

    #[test]
    fn each_owner_flag_maps_to_its_reason() {
        let cases: [(fn(&mut Sources), BusyReason); 5] = [
            (|s| s.recording = true, BusyReason::Recording),
            (|s| s.stopping = true, BusyReason::RecordingStopping),
            (|s| s.import = true, BusyReason::Import),
            (|s| s.retranscription = true, BusyReason::Retranscription),
            (|s| s.summaries = 2, BusyReason::Summary),
        ];
        for (set, expected) in cases {
            let mut sources = idle();
            set(&mut sources);
            assert_eq!(reasons(&sources, |_| false, &[]), vec![expected]);
        }
    }

    #[test]
    fn unfinished_or_unknown_onboarding_is_busy() {
        assert_eq!(
            reasons(&Sources::default(), |_| false, &[]),
            vec![BusyReason::Onboarding]
        );
    }

    #[test]
    fn held_guards_and_ui_activity_count_and_keep_priority_order() {
        let mut sources = idle();
        sources.recording = true;
        let busy = reasons(
            &sources,
            |reason| reason == BusyReason::ModelDownload,
            &[UiActivity::PostCall],
        );
        assert_eq!(
            busy,
            vec![BusyReason::Recording, BusyReason::PostCall, BusyReason::ModelDownload]
        );
    }

    #[test]
    fn a_guard_marks_its_reason_until_dropped() {
        // SpeechEngine is never held by production code, so this cannot race
        // with other tests that start real operations.
        assert!(!held(BusyReason::SpeechEngine));
        let first = hold(BusyReason::SpeechEngine);
        let second = hold(BusyReason::SpeechEngine);
        drop(first);
        assert!(held(BusyReason::SpeechEngine));
        drop(second);
        assert!(!held(BusyReason::SpeechEngine));
    }

    #[test]
    fn ui_lease_replaces_the_whole_set_and_expires() {
        let start = Instant::now();
        let mut lease = UiLease::new();
        assert!(lease.active(start).is_empty());

        lease.replace(vec![UiActivity::RecordingSave, UiActivity::PostCall], start);
        assert_eq!(lease.active(start + Duration::from_secs(60)).len(), 2);

        lease.replace(vec![UiActivity::PostCall], start + Duration::from_secs(60));
        assert_eq!(lease.active(start + Duration::from_secs(61)), &[UiActivity::PostCall]);

        assert!(lease
            .active(start + Duration::from_secs(60) + UI_LEASE)
            .is_empty());
    }
}
