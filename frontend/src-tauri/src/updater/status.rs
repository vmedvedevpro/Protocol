//! The updater's state and its transitions.
//!
//! One [`Machine`] lives in `UpdaterState` and is the only source of truth: the
//! frontend renders the snapshot built from it, the tray reads it, and every
//! check, download and install changes it through the methods below. They are
//! pure (no Tauri, no I/O), so the rules are unit-tested here; the callers in
//! `mod.rs` and `install.rs` do the I/O and persist what a transition reports.
//!
//! Two things are tracked separately: what Protocol is doing ([`Activity`]) and
//! which release is offered ([`Offer`]). An offer appears when a check finds a
//! newer release, gains `downloaded` once the user clicked Download and the
//! payload verified, and goes away when a later check no longer lists it as
//! newer than the running version (a release that was pulled is not installed).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    /// Markdown from the feed (the release's CHANGELOG section).
    pub notes: Option<String>,
    /// RFC 3339, as written in the feed.
    pub date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Activity {
    Idle,
    Checking { manual: bool },
    Downloading { received: u64, total: Option<u64> },
    Installing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub release: Release,
    /// A verified payload for this version is in the update cache.
    pub downloaded: bool,
    /// The install type cannot update itself (`.deb`): show a link only.
    pub manual_only: bool,
    /// Download was clicked during a recording; it starts when the recording ends.
    pub waiting_for_recording: bool,
}

/// Failure classes; the frontend chooses the wording for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// Offline, DNS, TLS, timeout.
    Network,
    /// No `latest.json` (no published release yet, or GitHub answered with an error).
    NoRelease,
    /// The newer release has no entry for this platform.
    NoPlatform,
    /// `latest.json` could not be read.
    Feed,
    /// The payload did not match its signature (or the signed version).
    Signature,
    /// The download stopped.
    Download,
    /// Not enough free space for the payload.
    DiskSpace,
    /// The installer could not start or the files could not be replaced.
    InstallStart,
    /// An install was started but the app is still on the old version.
    InstallIncomplete,
    /// macOS or AppImage: the app's folder cannot be written.
    Location,
}

impl ErrorKind {
    /// Failures that say nothing is wrong with this copy: no release yet, or
    /// none for this platform. Automatic checks stay silent and do not back off.
    pub fn is_benign(self) -> bool {
        matches!(self, ErrorKind::NoRelease | ErrorKind::NoPlatform)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Check,
    Download,
    Install,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateError {
    pub kind: ErrorKind,
    pub action: Action,
    /// Technical detail (logged and shown in small print), not the UI sentence.
    pub message: String,
    /// Unix milliseconds.
    pub at: i64,
    /// From an automatic check: shown only in Settings, never as a toast or pill.
    pub background: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckOutcome {
    /// No release newer than the running version.
    UpToDate,
    Found(Release),
    Failed(ErrorKind, String),
}

/// What the caller must do after a check, besides pushing the new snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckEffect {
    /// Record a completed check (resets the backoff); otherwise a failed one.
    pub completed: bool,
    /// The cached payload belongs to a release that is no longer offered.
    pub drop_download: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Machine {
    pub activity: Activity,
    pub offer: Option<Offer>,
    pub error: Option<UpdateError>,
    manual_only: bool,
}

impl Machine {
    pub fn new(manual_only: bool) -> Self {
        Self {
            activity: Activity::Idle,
            offer: None,
            error: None,
            manual_only,
        }
    }

    fn clear_error(&mut self, action: Action) {
        if self.error.as_ref().is_some_and(|error| error.action == action) {
            self.error = None;
        }
    }

    fn fail(&mut self, kind: ErrorKind, action: Action, message: String, at: i64, background: bool) {
        // An automatic check never hides what a user action reported.
        if background && self.error.as_ref().is_some_and(|error| !error.background) {
            return;
        }
        self.error = Some(UpdateError { kind, action, message, at, background });
    }

    /// Starts a check unless something else runs. A manual check while a
    /// download or install runs is refused; the caller shows the current state.
    pub fn begin_check(&mut self, manual: bool) -> bool {
        if self.activity != Activity::Idle {
            return false;
        }
        self.activity = Activity::Checking { manual };
        true
    }

    pub fn finish_check(&mut self, manual: bool, outcome: CheckOutcome, now: i64) -> CheckEffect {
        self.activity = Activity::Idle;
        match outcome {
            CheckOutcome::UpToDate => {
                let drop_download = self.offer.take().is_some_and(|offer| offer.downloaded);
                self.clear_error(Action::Check);
                CheckEffect { completed: true, drop_download }
            }
            CheckOutcome::Found(release) => {
                let mut drop_download = false;
                match &mut self.offer {
                    Some(offer) if offer.release.version == release.version => {
                        offer.release = release;
                    }
                    previous => {
                        drop_download = previous.as_ref().is_some_and(|offer| offer.downloaded);
                        *previous = Some(Offer {
                            release,
                            downloaded: false,
                            manual_only: self.manual_only,
                            waiting_for_recording: false,
                        });
                        // Download and install errors were about the old release.
                        self.error = None;
                    }
                }
                self.clear_error(Action::Check);
                CheckEffect { completed: true, drop_download }
            }
            CheckOutcome::Failed(kind, message) => {
                // The offer stays: a ready update is not lost to a failed check.
                if kind.is_benign() {
                    if manual {
                        self.fail(kind, Action::Check, message, now, false);
                    } else {
                        self.clear_error(Action::Check);
                    }
                    CheckEffect { completed: true, drop_download: false }
                } else {
                    self.fail(kind, Action::Check, message, now, !manual);
                    CheckEffect { completed: false, drop_download: false }
                }
            }
        }
    }

    /// The user asked to download the offered release. Returns true when the
    /// caller should start the download now; during a recording it is queued.
    pub fn request_download(&mut self, recording: bool) -> bool {
        if self.activity != Activity::Idle {
            return false;
        }
        let Some(offer) = self.offer.as_mut() else { return false };
        if offer.downloaded || offer.manual_only {
            return false;
        }
        if recording {
            offer.waiting_for_recording = true;
            return false;
        }
        true
    }

    /// True once, when a queued download should start now (the recording
    /// ended); the caller starts it.
    pub fn take_pending_download(&mut self, recording: bool) -> bool {
        if recording || self.activity != Activity::Idle {
            return false;
        }
        match self.offer.as_mut() {
            Some(offer) if offer.waiting_for_recording && !offer.downloaded => {
                offer.waiting_for_recording = false;
                true
            }
            _ => false,
        }
    }

    pub fn begin_download(&mut self) -> Option<String> {
        if self.activity != Activity::Idle {
            return None;
        }
        let offer = self.offer.as_mut().filter(|offer| !offer.downloaded && !offer.manual_only)?;
        offer.waiting_for_recording = false;
        let version = offer.release.version.clone();
        self.activity = Activity::Downloading { received: 0, total: None };
        self.clear_error(Action::Download);
        self.clear_error(Action::Install);
        Some(version)
    }

    pub fn download_progress(&mut self, received: u64, total: Option<u64>) {
        if let Activity::Downloading { .. } = self.activity {
            self.activity = Activity::Downloading { received, total };
        }
    }

    pub fn finish_download(&mut self, version: &str, result: Result<(), (ErrorKind, String)>, now: i64) {
        self.activity = Activity::Idle;
        let Some(offer) = self.offer.as_mut().filter(|offer| offer.release.version == version) else {
            return;
        };
        match result {
            Ok(()) => offer.downloaded = true,
            Err((kind, message)) => self.fail(kind, Action::Download, message, now, false),
        }
    }

    /// A recording started during the download: it was cancelled and restarts
    /// when the recording ends (the plugin cannot resume a partial download).
    pub fn download_interrupted(&mut self, version: &str) {
        self.activity = Activity::Idle;
        if let Some(offer) = self.offer.as_mut().filter(|offer| offer.release.version == version) {
            offer.waiting_for_recording = true;
        }
    }

    /// A verified payload from an earlier session was found in the cache.
    pub fn restore(&mut self, release: Release) {
        self.offer = Some(Offer {
            release,
            downloaded: true,
            manual_only: false,
            waiting_for_recording: false,
        });
    }

    /// The cached payload is gone or no longer verifies: offer a new download.
    pub fn forget_download(&mut self) {
        if let Some(offer) = self.offer.as_mut() {
            offer.downloaded = false;
        }
    }

    pub fn ready_version(&self) -> Option<&str> {
        self.offer
            .as_ref()
            .filter(|offer| offer.downloaded)
            .map(|offer| offer.release.version.as_str())
    }

    pub fn begin_install(&mut self) -> Option<String> {
        if self.activity != Activity::Idle {
            return None;
        }
        let version = self.ready_version()?.to_string();
        self.activity = Activity::Installing;
        self.clear_error(Action::Install);
        Some(version)
    }

    pub fn install_failed(&mut self, kind: ErrorKind, message: String, now: i64) {
        self.activity = Activity::Idle;
        self.fail(kind, Action::Install, message, now, false);
    }

    /// The install was refused before anything changed (busy): back to ready.
    pub fn install_skipped(&mut self) {
        if self.activity == Activity::Installing {
            self.activity = Activity::Idle;
        }
    }

    /// At launch the install-attempt marker named a version this copy is not on.
    pub fn install_incomplete(&mut self, version: &str, now: i64) {
        self.fail(
            ErrorKind::InstallIncomplete,
            Action::Install,
            format!("the update to {version} did not finish"),
            now,
            false,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(version: &str) -> Release {
        Release {
            version: version.into(),
            notes: Some(format!("notes for {version}")),
            date: None,
        }
    }

    fn offered(version: &str) -> Machine {
        let mut machine = Machine::new(false);
        assert!(machine.begin_check(false));
        machine.finish_check(false, CheckOutcome::Found(release(version)), 1);
        machine
    }

    fn downloaded(version: &str) -> Machine {
        let mut machine = offered(version);
        assert!(machine.request_download(false));
        assert_eq!(machine.begin_download().as_deref(), Some(version));
        machine.finish_download(version, Ok(()), 2);
        machine
    }

    #[test]
    fn a_found_release_is_offered_but_not_downloaded() {
        let machine = offered("0.3.1");
        let offer = machine.offer.as_ref().unwrap();
        assert_eq!(offer.release.version, "0.3.1");
        assert!(!offer.downloaded);
        assert_eq!(machine.activity, Activity::Idle);
        assert_eq!(machine.ready_version(), None);
    }

    #[test]
    fn only_one_operation_runs_at_a_time() {
        let mut machine = offered("0.3.1");
        assert!(machine.request_download(false));
        machine.begin_download().unwrap();
        assert!(!machine.begin_check(true));
        assert!(machine.begin_download().is_none());
        assert!(machine.begin_install().is_none());
    }

    #[test]
    fn download_progress_then_ready() {
        let mut machine = offered("0.3.1");
        machine.begin_download().unwrap();
        machine.download_progress(10, Some(100));
        assert_eq!(machine.activity, Activity::Downloading { received: 10, total: Some(100) });
        machine.finish_download("0.3.1", Ok(()), 3);
        assert_eq!(machine.ready_version(), Some("0.3.1"));
        assert_eq!(machine.activity, Activity::Idle);
    }

    #[test]
    fn a_download_requested_during_a_recording_waits_for_it() {
        let mut machine = offered("0.3.1");
        assert!(!machine.request_download(true));
        assert!(machine.offer.as_ref().unwrap().waiting_for_recording);
        assert!(!machine.take_pending_download(true));
        assert!(machine.take_pending_download(false));
        assert!(!machine.take_pending_download(false), "started once");
        machine.begin_download().unwrap();
        assert!(!machine.offer.as_ref().unwrap().waiting_for_recording);
    }

    #[test]
    fn a_recording_that_starts_mid_download_requeues_it() {
        let mut machine = offered("0.3.1");
        machine.begin_download().unwrap();
        machine.download_interrupted("0.3.1");
        assert_eq!(machine.activity, Activity::Idle);
        assert!(machine.take_pending_download(false));
        assert_eq!(machine.ready_version(), None);
    }

    #[test]
    fn a_failed_download_keeps_the_offer_and_reports_to_the_user() {
        let mut machine = offered("0.3.1");
        machine.begin_download().unwrap();
        machine.finish_download("0.3.1", Err((ErrorKind::Signature, "bad".into())), 5);
        let error = machine.error.clone().unwrap();
        assert_eq!((error.kind, error.action, error.background), (ErrorKind::Signature, Action::Download, false));
        assert!(machine.offer.is_some());
        // Trying again clears the error.
        assert!(machine.request_download(false));
        machine.begin_download().unwrap();
        assert!(machine.error.is_none());
    }

    #[test]
    fn the_same_release_found_again_keeps_the_download() {
        let mut machine = downloaded("0.3.1");
        machine.begin_check(false);
        let effect = machine.finish_check(false, CheckOutcome::Found(release("0.3.1")), 9);
        assert_eq!(effect, CheckEffect { completed: true, drop_download: false });
        assert_eq!(machine.ready_version(), Some("0.3.1"));
    }

    #[test]
    fn a_newer_release_replaces_a_ready_one() {
        let mut machine = downloaded("0.3.1");
        machine.begin_check(false);
        let effect = machine.finish_check(false, CheckOutcome::Found(release("0.3.2")), 9);
        assert!(effect.drop_download);
        let offer = machine.offer.unwrap();
        assert_eq!(offer.release.version, "0.3.2");
        assert!(!offer.downloaded);
    }

    #[test]
    fn a_pulled_release_is_no_longer_offered_or_installed() {
        let mut machine = downloaded("0.3.1");
        machine.begin_check(false);
        let effect = machine.finish_check(false, CheckOutcome::UpToDate, 9);
        assert_eq!(effect, CheckEffect { completed: true, drop_download: true });
        assert!(machine.offer.is_none());
    }

    #[test]
    fn failed_checks_keep_the_offer_and_stay_quiet_in_the_background() {
        let mut machine = downloaded("0.3.1");
        machine.begin_check(false);
        let effect = machine.finish_check(false, CheckOutcome::Failed(ErrorKind::Network, "offline".into()), 9);
        assert!(!effect.completed);
        assert_eq!(machine.ready_version(), Some("0.3.1"));
        assert!(machine.error.as_ref().unwrap().background);

        machine.begin_check(true);
        machine.finish_check(true, CheckOutcome::Failed(ErrorKind::Network, "offline".into()), 10);
        assert!(!machine.error.as_ref().unwrap().background);
    }

    #[test]
    fn benign_failures_count_as_completed_and_are_silent_unless_manual() {
        let mut machine = Machine::new(false);
        machine.begin_check(false);
        let effect = machine.finish_check(false, CheckOutcome::Failed(ErrorKind::NoRelease, "404".into()), 1);
        assert!(effect.completed);
        assert!(machine.error.is_none());

        machine.begin_check(true);
        machine.finish_check(true, CheckOutcome::Failed(ErrorKind::NoPlatform, "none".into()), 2);
        assert_eq!(machine.error.as_ref().unwrap().kind, ErrorKind::NoPlatform);
    }

    #[test]
    fn a_background_failure_does_not_hide_a_user_visible_error() {
        let mut machine = offered("0.3.1");
        machine.begin_download().unwrap();
        machine.finish_download("0.3.1", Err((ErrorKind::Download, "reset".into())), 5);
        machine.begin_check(false);
        machine.finish_check(false, CheckOutcome::Failed(ErrorKind::Network, "offline".into()), 6);
        assert_eq!(machine.error.as_ref().unwrap().action, Action::Download);
    }

    #[test]
    fn manual_only_installs_get_an_offer_they_cannot_download() {
        let mut machine = Machine::new(true);
        machine.begin_check(true);
        machine.finish_check(true, CheckOutcome::Found(release("0.3.1")), 1);
        assert!(machine.offer.as_ref().unwrap().manual_only);
        assert!(!machine.request_download(false));
        assert!(machine.begin_download().is_none());
    }

    #[test]
    fn install_needs_a_downloaded_release_and_failures_keep_it() {
        let mut machine = offered("0.3.1");
        assert!(machine.begin_install().is_none());

        let mut machine = downloaded("0.3.1");
        assert_eq!(machine.begin_install().as_deref(), Some("0.3.1"));
        assert_eq!(machine.activity, Activity::Installing);
        machine.install_failed(ErrorKind::InstallStart, "no exe".into(), 7);
        assert_eq!(machine.activity, Activity::Idle);
        assert_eq!(machine.ready_version(), Some("0.3.1"));
        assert_eq!(machine.error.as_ref().unwrap().action, Action::Install);

        assert!(machine.begin_install().is_some());
        assert!(machine.error.is_none());
        machine.install_skipped();
        assert_eq!(machine.activity, Activity::Idle);
    }

    #[test]
    fn a_restored_download_is_ready_without_a_check() {
        let mut machine = Machine::new(false);
        machine.restore(release("0.3.1"));
        assert_eq!(machine.ready_version(), Some("0.3.1"));
        machine.forget_download();
        assert_eq!(machine.ready_version(), None);
        assert!(machine.request_download(false));
    }

    #[test]
    fn snapshot_fields_serialize_in_camel_case() {
        let machine = downloaded("0.3.1");
        let offer = serde_json::to_value(machine.offer.unwrap()).unwrap();
        assert_eq!(offer["waitingForRecording"], false);
        assert_eq!(offer["manualOnly"], false);
        let activity = serde_json::to_value(Activity::Downloading { received: 1, total: None }).unwrap();
        assert_eq!(activity, serde_json::json!({ "state": "downloading", "received": 1, "total": null }));
    }
}
