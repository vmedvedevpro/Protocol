//! The crash guard around the NPU's native steps (#66), the pattern of
//! `whisper_engine::openvino`'s (#82) with a marker of its own: a broken NPU
//! driver or plugin crashes inside these calls, where no `Result` reaches the
//! app. The marker names the steps running and is removed when none runs. A
//! marker found by the first step of a process was left by a process that
//! died in them, and the NPU then stays off (state `failed`, Parakeet on the
//! processor) until the person retries ([`retry`]); otherwise the app would
//! crash again at each start. A process that ends on purpose while a step
//! runs removes it first ([`set_closing`]).
//!
//! Separate from Whisper's guard: a crash on the NPU does not turn off
//! Whisper on the GPU, nor the other way round.

use std::path::PathBuf;
use std::sync::Mutex;

/// The NPU's native work that can take the process down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Loading OpenVINO's C API.
    Load,
    /// Asking the NPU plugin for the device and its versions.
    Device,
    /// Compiling the encoder for the NPU, or reading it from the cache.
    Compile,
    /// The first inference of a compiled encoder.
    FirstRun,
}

impl Step {
    fn describe(self) -> &'static str {
        match self {
            Step::Load => "loading Intel's libraries",
            Step::Device => "looking for the NPU",
            Step::Compile => "preparing Parakeet for the NPU",
            Step::FirstRun => "running Parakeet on the NPU for the first time",
        }
    }
}

pub(super) struct Guard {
    marker: Option<PathBuf>,
    checked: bool,
    stopped: Option<String>,
    /// One entry per step running now, in the order they started.
    running: Vec<Step>,
    closing: bool,
}

impl Guard {
    pub(super) const fn new(marker: Option<PathBuf>) -> Mutex<Guard> {
        Mutex::new(Guard { marker, checked: false, stopped: None, running: Vec::new(), closing: false })
    }

    /// Beside Whisper's marker, outside the runtime folders prunes empty.
    fn marker(&self) -> PathBuf {
        self.marker
            .clone()
            .unwrap_or_else(|| crate::paths::install_data_root().join("runtimes").join("parakeet-npu.attempt"))
    }

    /// Reads the marker once per process, before this process writes one.
    fn check(&mut self) {
        if self.checked {
            return;
        }
        self.checked = true;
        if let Ok(marker) = std::fs::read_to_string(self.marker()) {
            let steps: Vec<&str> = marker.lines().map(str::trim).filter(|step| !step.is_empty()).collect();
            let steps = if steps.is_empty() { "running".to_string() } else { steps.join(" and ") };
            let message = format!("Protocol closed unexpectedly the last time it was {steps}, so Parakeet runs on the processor.");
            log::error!("[npu] {message}");
            self.stopped = Some(message);
        }
    }

    /// Writes the steps running now into the marker, one per line, or
    /// removes it when none runs or the process is closing.
    fn record(&self) {
        let marker = self.marker();
        if self.running.is_empty() || self.closing {
            let _ = std::fs::remove_file(&marker);
            return;
        }
        let mut steps: Vec<&str> = Vec::new();
        for step in &self.running {
            if !steps.contains(&step.describe()) {
                steps.push(step.describe());
            }
        }
        let written = marker.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&marker, steps.join("\n")));
        if let Err(error) = written {
            log::warn!("[npu] cannot write the crash marker {}: {error}", marker.display());
        }
    }
}

static GUARD: Mutex<Guard> = Guard::new(None);

fn lock(guard: &Mutex<Guard>) -> std::sync::MutexGuard<'_, Guard> {
    guard.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Why the NPU is off after a crash, if it is.
pub fn stopped() -> Option<String> {
    stopped_in(&GUARD)
}

pub(super) fn stopped_in(guard: &Mutex<Guard>) -> Option<String> {
    let mut guard = lock(guard);
    guard.check();
    guard.stopped.clone()
}

/// Lets the NPU run again after a crash stopped it.
pub fn retry() {
    retry_in(&GUARD);
}

pub(super) fn retry_in(guard: &Mutex<Guard>) {
    let mut guard = lock(guard);
    guard.checked = true;
    guard.stopped = None;
    guard.record();
}

/// The process is ending on purpose (`RunEvent::Exit`, or the updater
/// closing the app to install): a step it cuts short did not crash.
pub fn set_closing(closing: bool) {
    set_closing_in(&GUARD, closing);
}

pub(super) fn set_closing_in(guard: &Mutex<Guard>, closing: bool) {
    let mut guard = lock(guard);
    guard.closing = closing;
    guard.record();
}

/// Whether the process is ending on purpose.
pub fn closing() -> bool {
    lock(&GUARD).closing
}

/// Runs `work` inside the crash guard; `Err` when a crash stopped the NPU.
pub fn guarded<T>(step: Step, work: impl FnOnce() -> T) -> Result<T, String> {
    guarded_in(&GUARD, step, work)
}

pub(super) fn guarded_in<T>(guard: &Mutex<Guard>, step: Step, work: impl FnOnce() -> T) -> Result<T, String> {
    {
        let mut state = lock(guard);
        state.check();
        if let Some(stopped) = &state.stopped {
            return Err(stopped.clone());
        }
        state.running.push(step);
        state.record();
    }
    /// Ends the step also when `work` panics.
    struct Running<'a>(&'a Mutex<Guard>, Step);
    impl Drop for Running<'_> {
        fn drop(&mut self) {
            let mut state = lock(self.0);
            if let Some(index) = state.running.iter().position(|step| *step == self.1) {
                state.running.remove(index);
            }
            state.record();
        }
    }
    let _running = Running(guard, step);
    Ok(work())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_marker_left_by_a_crash_stops_the_npu_until_a_retry() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("parakeet-npu.attempt");
        let guard = Guard::new(Some(marker.clone()));
        // A step runs with the marker in place, and removes it after.
        let seen = guarded_in(&guard, Step::Compile, || std::fs::read_to_string(&marker).unwrap()).unwrap();
        assert_eq!(seen, "preparing Parakeet for the NPU");
        assert!(!marker.exists());

        // The next process finds a marker: the NPU stays off.
        std::fs::write(&marker, "preparing Parakeet for the NPU\nrunning Parakeet on the NPU for the first time").unwrap();
        let next = Guard::new(Some(marker.clone()));
        let stopped = stopped_in(&next).unwrap();
        assert!(stopped.contains("preparing Parakeet for the NPU and running Parakeet on the NPU"), "{stopped}");
        assert!(guarded_in(&next, Step::Device, || ()).is_err());
        retry_in(&next);
        assert!(!marker.exists());
        assert_eq!(stopped_in(&next), None);
        assert!(guarded_in(&next, Step::Device, || ()).is_ok());
    }

    #[test]
    fn a_clean_quit_during_the_first_compile_is_not_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("parakeet-npu.attempt");
        let guard = Guard::new(Some(marker.clone()));
        // The app exits (or the updater closes it) while the compile runs:
        // the marker goes at once, and the steps after it write none.
        guarded_in(&guard, Step::Compile, || {
            assert!(marker.exists());
            set_closing_in(&guard, true);
            assert!(!marker.exists());
            guarded_in(&guard, Step::FirstRun, || assert!(!marker.exists())).unwrap();
        })
        .unwrap();
        assert!(!marker.exists());
        // The next start finds no marker: the NPU is not stopped.
        assert_eq!(stopped_in(&Guard::new(Some(marker.clone()))), None);

        // An install that failed reopens the app: steps record again.
        set_closing_in(&guard, false);
        guarded_in(&guard, Step::Compile, || assert!(marker.exists())).unwrap();
    }
}
