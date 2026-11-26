//! The Speech check's crash note (#233): a GPU or NPU driver can close the
//! app, so before each step the check writes down which step it starts and
//! the results so far, and clears the step when it ends. A note found at the
//! next start with a step still in it names the step that closed the app;
//! the group then offers to run the remaining steps.
//!
//! The note lives in the data folder beside the engines' own crash markers
//! (`<data>/runtimes/whisper-vulkan.attempt` and the NPU's and OpenVINO's).
//! Those markers do their own work at the next start: after a crash in a
//! Whisper GPU step the Vulkan guard (#176) keeps Whisper on the processor,
//! so a resumed or later check runs it there and its report says why. A clean
//! quit during a check ([`set_closing`]) is not a crash: the note goes.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::report::{Pair, StepKind, StepReport, StepStatus, System};

/// The reason a step that closed the app gives.
pub const CLOSED_REASON: &str = "Protocol closed while this step ran";

/// What the check writes before each step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub plan: super::Plan,
    pub system: System,
    pub pair: Pair,
    pub selected: Pair,
    /// The steps that ended, in order.
    pub done: Vec<StepReport>,
    /// The step running now.
    #[serde(default)]
    pub running: Option<StepKind>,
    /// The step an earlier start found running last: it closed the app. Every
    /// step that did is also in `done`, as ClosedTheApp, so a second crash
    /// in a resumed run neither hides the first nor runs it again.
    #[serde(default)]
    pub closed_in: Option<StepKind>,
    pub warnings: Vec<String>,
}

impl Note {
    /// A new run's note.
    pub fn of(plan: super::Plan, system: System) -> Self {
        Note { pair: plan.pair(), selected: plan.selected(), plan, system, done: Vec::new(), running: None, closed_in: None, warnings: Vec::new() }
    }

    /// The steps still to run after the ones done, those that closed the app among them.
    pub fn remaining(&self) -> Vec<StepKind> {
        self.plan.steps().into_iter().filter(|kind| !self.done.iter().any(|step| step.kind == *kind)).collect()
    }

    /// The steps done, in the plan's order.
    pub fn done_in_order(&self) -> Vec<StepReport> {
        self.plan.steps().into_iter().filter_map(|kind| self.done.iter().find(|step| step.kind == kind).cloned()).collect()
    }
}

struct Store {
    path: Option<PathBuf>,
    closing: bool,
}

static STORE: Mutex<Store> = Mutex::new(Store { path: None, closing: false });

fn lock() -> std::sync::MutexGuard<'static, Store> {
    STORE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn path_in(store: &Store) -> PathBuf {
    store.path.clone().unwrap_or_else(|| crate::paths::install_data_root().join("speech-check.json"))
}

/// Writes `note` whole: beside its place, then renamed into it, so a crash
/// leaves the old note or the new one, never a part.
fn write_at(path: &Path, note: &Note) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = path.with_extension("json.part");
    std::fs::write(&part, serde_json::to_vec_pretty(note).map_err(std::io::Error::other)?)?;
    std::fs::rename(&part, path)
}

/// Records `note`, unless the app is closing (a quit is not a crash).
pub fn write(note: &Note) {
    let store = lock();
    if store.closing {
        return;
    }
    if let Err(error) = write_at(&path_in(&store), note) {
        log::warn!("[speech check] cannot write the crash note: {error}");
    }
}

pub fn remove() {
    let store = lock();
    let _ = std::fs::remove_file(path_in(&store));
}

/// The note a run left, if any. A note with a step still running was left by
/// a process that closed during that step: it is rewritten with that step
/// done as ClosedTheApp and named in `closed_in`, so a second start does not
/// count the crash again and a later one still shows it.
pub fn take_interrupted() -> Option<Note> {
    let store = lock();
    let path = path_in(&store);
    let bytes = std::fs::read(&path).ok()?;
    let mut note: Note = match serde_json::from_slice(&bytes) {
        Ok(note) => note,
        Err(error) => {
            log::warn!("[speech check] ignoring an unreadable crash note: {error}");
            let _ = std::fs::remove_file(&path);
            return None;
        }
    };
    if let Some(step) = note.running.take() {
        log::error!("[speech check] Protocol closed while checking {}", step.title());
        if !note.done.iter().any(|done| done.kind == step) {
            note.done.push(StepReport::new(step, StepStatus::ClosedTheApp).with_reason(CLOSED_REASON));
        }
        note.closed_in = Some(step);
        if let Err(error) = write_at(&path, &note) {
            log::warn!("[speech check] cannot rewrite the crash note: {error}");
        }
    }
    Some(note)
}

/// The process is ending on purpose: a check it cuts short did not crash,
/// so its note goes and no later write brings it back.
pub fn set_closing(closing: bool) {
    let mut store = lock();
    store.closing = closing;
    if closing {
        let _ = std::fs::remove_file(path_in(&store));
    }
}

#[cfg(test)]
pub(crate) fn use_path_for_tests(path: Option<PathBuf>) {
    let mut store = lock();
    store.path = path;
    store.closing = false;
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The note's file is process-wide; the tests that use it take turns.
    pub(crate) static FILE: Mutex<()> = Mutex::new(());

    pub(crate) fn note() -> Note {
        Note {
            plan: crate::speech_check::Plan::for_tests(),
            system: System::default(),
            pair: Pair::default(),
            selected: Pair::default(),
            done: Vec::new(),
            running: None,
            closed_in: None,
            warnings: Vec::new(),
        }
    }

    #[test]
    fn a_step_still_running_at_the_next_start_closed_the_app() {
        let _file = FILE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let folder = tempfile::tempdir().unwrap();
        use_path_for_tests(Some(folder.path().join("speech-check.json")));
        let mut written = note();
        written.done.push(StepReport::new(StepKind::Parakeet, StepStatus::Passed));
        written.running = Some(StepKind::Whisper);
        write(&written);

        let found = take_interrupted().expect("a note");
        assert_eq!(found.closed_in, Some(StepKind::Whisper));
        assert_eq!(found.running, None);
        assert_eq!(found.remaining(), vec![StepKind::Pyannote, StepKind::Nemotron]);
        // A second start still shows it, once.
        let again = take_interrupted().unwrap();
        assert_eq!(again.closed_in, Some(StepKind::Whisper));
        assert_eq!(again.done.iter().filter(|step| step.status == StepStatus::ClosedTheApp).count(), 1);
        remove();
        assert!(take_interrupted().is_none());
        use_path_for_tests(None);
    }

    #[test]
    fn a_second_crash_in_a_resumed_run_keeps_the_first() {
        let _file = FILE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let folder = tempfile::tempdir().unwrap();
        use_path_for_tests(Some(folder.path().join("speech-check.json")));
        let mut written = note();
        written.running = Some(StepKind::Whisper);
        write(&written);
        // The resumed run closes the app in another step.
        let mut resumed = take_interrupted().unwrap();
        resumed.running = Some(StepKind::Nemotron);
        write(&resumed);

        let found = take_interrupted().unwrap();
        assert_eq!(found.closed_in, Some(StepKind::Nemotron));
        let closed: Vec<StepKind> = found.done.iter().filter(|step| step.status == StepStatus::ClosedTheApp).map(|step| step.kind).collect();
        assert_eq!(closed, vec![StepKind::Whisper, StepKind::Nemotron]);
        assert_eq!(found.remaining(), vec![StepKind::Parakeet, StepKind::Pyannote], "Whisper does not run again");
        assert_eq!(found.done_in_order().iter().map(|step| step.kind).collect::<Vec<_>>(), vec![StepKind::Whisper, StepKind::Nemotron]);
        remove();
        use_path_for_tests(None);
    }

    #[test]
    fn a_clean_quit_is_not_a_crash() {
        let _file = FILE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let folder = tempfile::tempdir().unwrap();
        use_path_for_tests(Some(folder.path().join("speech-check.json")));
        let mut written = note();
        written.running = Some(StepKind::Whisper);
        write(&written);
        set_closing(true);
        // A step ending after the quit began writes nothing back.
        write(&written);
        assert!(!folder.path().join("speech-check.json").exists());
        use_path_for_tests(None);
    }

    #[test]
    fn an_unreadable_note_is_dropped() {
        let _file = FILE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("speech-check.json");
        use_path_for_tests(Some(path.clone()));
        std::fs::write(&path, b"{ half").unwrap();
        assert!(take_interrupted().is_none());
        assert!(!path.exists());
        use_path_for_tests(None);
    }
}
