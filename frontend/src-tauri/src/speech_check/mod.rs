//! Speech check (#233): Settings › Advanced runs every speech engine on a
//! short known sample, each on the device Protocol picks on this computer,
//! and writes a report a tester can paste into a chat. The feature note is
//! docs/SPEECH_CHECK.md.
//!
//! Ownership. The WebView decides the pair (`api/intel.ts`, as Settings'
//! For this computer card does) and sends it in a [`Plan`]; from then on the
//! run is native: it outlives the WebView, holds `BusyReason::SpeechCheck`
//! for its whole run, and writes its crash note (`note.rs`) before each step.
//!
//! Engines. The steps (`steps.rs`) build engines of their own on the models
//! folder, never the recording's. Before the first step the check unloads
//! the app's idle engines, under the engine lifecycle lock and only while
//! nothing records or transcribes: two copies of a model would double its
//! memory, and the NPU's "active" flag and OpenVINO's last backend outcome
//! are process-wide. After the last step it loads back what was loaded and
//! puts OpenVINO's outcome back. It changes no setting and no selection.
//!
//! Recording. Run is refused during a recording; a recording's start calls
//! [`cancel_for_recording`] before it takes the lifecycle lock and does not
//! wait: the piece in flight finishes on its worker, the check stops at the
//! next piece and gives nothing back to the recording's engines.

mod hardware;
pub mod note;
pub mod report;
pub mod sample;
pub mod score;
mod steps;

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::updater::busy::{self, BusyReason};
use note::Note;
use report::{Outcome, Pair, Report, StepKind, StepReport, StepStatus};

/// What the WebView asks the check to run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// The pair Protocol picks for this computer: Parakeet's model id…
    pub live_model: String,
    /// …and Whisper's, the Intel GPU version's id where the pair names it.
    pub post_meeting_model: String,
    /// What the tester selected in Settings, as `engine:model`.
    #[serde(default)]
    pub selected_live: Option<String>,
    #[serde(default)]
    pub selected_post_meeting: Option<String>,
}

impl Plan {
    fn pair(&self) -> Pair {
        Pair {
            live: Some(format!("parakeet:{}", self.live_model)),
            post_meeting: Some(format!("whisper:{}", self.post_meeting_model)),
        }
    }

    fn selected(&self) -> Pair {
        Pair { live: self.selected_live.clone(), post_meeting: self.selected_post_meeting.clone() }
    }

    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        Plan {
            live_model: "parakeet-tdt-0.6b-v3-int8".into(),
            post_meeting_model: "large-v3-turbo-q5_0".into(),
            selected_live: None,
            selected_post_meeting: None,
        }
    }
}

/// What the Settings group shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Idle,
    #[serde(rename_all = "camelCase")]
    Running {
        /// The step running now, `None` while the check prepares.
        step: Option<StepKind>,
        steps: Vec<StepKind>,
        done: Vec<StepReport>,
        cancelling: bool,
    },
    /// The check ended: passed, failed or cancelled (`report.outcome`).
    #[serde(rename_all = "camelCase")]
    Finished { report: Report, text: String },
    /// Protocol closed during the check (`note.rs`).
    #[serde(rename_all = "camelCase")]
    Interrupted {
        /// The step that ran, `None` when it closed between steps.
        closed_in: Option<StepKind>,
        remaining: Vec<StepKind>,
        report: Report,
        text: String,
    },
}

pub const CHANGED_EVENT: &str = "speech-check-changed";

static STATUS: Mutex<Status> = Mutex::new(Status::Idle);
static CANCEL: AtomicBool = AtomicBool::new(false);
/// A recording started during the run: nothing is given back to its engines.
static RECORDING_STARTED: AtomicBool = AtomicBool::new(false);

/// Where a status change goes: the WebView's event in the app, a list in tests.
trait Emit {
    fn changed(&self, status: &Status);
}

impl<R: Runtime> Emit for AppHandle<R> {
    fn changed(&self, status: &Status) {
        let _ = self.emit(CHANGED_EVENT, status);
    }
}

/// The status, held. `CANCEL` and `RECORDING_STARTED` change only under this
/// lock too, so a start's reset and a cancel never cross.
fn lock_status() -> MutexGuard<'static, Status> {
    STATUS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn status() -> Status {
    lock_status().clone()
}

/// Sets and emits `status` under one hold of the lock, so the events reach
/// the WebView in the order of the changes.
fn set_status(emit: &impl Emit, status: Status) {
    let mut current = lock_status();
    *current = status;
    emit.changed(&current);
}

/// The step running now, keeping a Cancel that came in meanwhile.
fn set_running_step(emit: &impl Emit, step: StepKind, done: Vec<StepReport>) {
    let mut current = lock_status();
    if let Status::Running { step: running, done: so_far, .. } = &mut *current {
        *running = Some(step);
        *so_far = done;
        emit.changed(&current);
    }
}

pub fn is_running() -> bool {
    matches!(*lock_status(), Status::Running { .. })
}

/// For the start of other speech or GPU work (an import, a retranscription,
/// the post-call pass's steps, a summary on this computer): refused while a
/// check runs, which has put the app's engines away and times its own.
pub fn refuse_beside(work: &str) -> Result<(), String> {
    if is_running() {
        return Err(format!("{work} can't start during the speech check. Try again when it ends, or cancel it in Settings › Advanced"));
    }
    Ok(())
}

/// Marks a running check as cancelling; false when nothing runs, so a
/// Cancel that arrives after the finish changes nothing.
fn mark_cancelling(status: &mut Status) -> bool {
    match status {
        Status::Running { cancelling, .. } => {
            CANCEL.store(true, Ordering::SeqCst);
            *cancelling = true;
            true
        }
        _ => false,
    }
}

/// A step's own engines exist: set before a step may build them, cleared
/// once it has returned and dropped them.
static STEP_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// How long a recording's start waits for the step in flight to drop its
/// engines. A step stops at its next piece: a live piece (at most 6 s of
/// audio, 0.3 s here) or a Whisper piece (1 s here on the GPU), or a whole
/// clip through a speaker engine, the longest unit (Nemotron 1.8 s here).
/// Five seconds covers that on a computer about three times slower, while
/// the meeting's first words are still being said; after it the recording
/// goes on beside the check's engines, which is memory for a moment, not a
/// lost start.
const RECORDING_WAIT: Duration = Duration::from_secs(5);

/// Called by a recording's start before it takes the lifecycle lock: the
/// check stops, and the recording waits up to [`RECORDING_WAIT`] for the
/// step in flight to drop its engines, so the two never hold models at once.
pub async fn cancel_for_recording() {
    {
        let mut current = lock_status();
        if !matches!(*current, Status::Running { .. }) {
            return;
        }
        log::info!("[speech check] a recording starts: cancelling the check");
        RECORDING_STARTED.store(true, Ordering::SeqCst);
        mark_cancelling(&mut current);
    }
    if !step_ended_within(RECORDING_WAIT).await {
        log::warn!("[speech check] the step in flight did not end within {RECORDING_WAIT:?}; the recording starts beside it");
    }
}

/// Whether no step holds engines, now or within `bound`.
async fn step_ended_within(bound: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + bound;
    while STEP_IN_FLIGHT.load(Ordering::SeqCst) {
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    true
}

/// The busy reasons the check does not run beside: it unloads the app's
/// engines, and its timings would include the other work.
const REFUSED_WHILE: [BusyReason; 8] = [
    BusyReason::Recording,
    BusyReason::RecordingStopping,
    BusyReason::RecordingSave,
    BusyReason::Import,
    BusyReason::Retranscription,
    BusyReason::Diarization,
    BusyReason::PostCall,
    BusyReason::Summary,
];

fn refusal() -> Option<String> {
    let busy = busy::current();
    if busy.iter().any(|reason| matches!(reason, BusyReason::Recording | BusyReason::RecordingStopping | BusyReason::RecordingSave)) {
        return Some("The speech check can't run during a recording".into());
    }
    if busy.contains(&BusyReason::Summary) {
        return Some("The speech check can't run while a summary is being written".into());
    }
    busy.iter()
        .any(|reason| REFUSED_WHILE.contains(reason))
        .then(|| "The speech check can't run while a transcript is being made".into())
}

/// The note left by a run that Protocol closed during, read at startup.
pub fn startup() {
    let Some(note) = note::take_interrupted() else { return };
    *lock_status() = interrupted(&note);
}

fn interrupted(note: &Note) -> Status {
    let report = build_report(note, note.done_in_order(), Outcome::Interrupted);
    let text = report.render();
    Status::Interrupted { closed_in: note.closed_in, remaining: note.remaining(), report, text }
}

fn build_report(note: &Note, steps: Vec<StepReport>, outcome: Outcome) -> Report {
    let mut warnings = note.warnings.clone();
    for step in &steps {
        if let Some(fallback) = &step.fallback {
            warnings.push(format!("{}: fell back from {} to {}: {}", step.kind.title(), fallback.from.name, fallback.to.name, fallback.error));
        }
        if step.status == StepStatus::Failed {
            if let Some(reason) = &step.reason {
                warnings.push(format!("{}: {reason}", step.kind.title()));
            }
        }
    }
    let report = Report {
        format: report::FORMAT,
        created: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        outcome,
        system: note.system.clone(),
        pair: note.plan.pair(),
        selected: note.plan.selected(),
        steps,
        warnings,
    };
    report.scrubbed(&report::Private::of_this_computer())
}

#[tauri::command]
pub fn speech_check_status() -> Status {
    status()
}

#[tauri::command]
pub async fn speech_check_run<R: Runtime>(app: AppHandle<R>, plan: Plan) -> Result<(), String> {
    start(app, plan, None)
}

/// Runs the steps a run Protocol closed during did not finish.
#[tauri::command]
pub async fn speech_check_resume<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let note = resumable()?;
    start(app, note.plan.clone(), Some(note))
}

/// The note to resume: only while the group shows the interrupted check, so
/// a resume sent twice, or after Run again, starts nothing.
fn resumable() -> Result<Note, String> {
    let nothing = || "There is no check to resume".to_string();
    if !matches!(status(), Status::Interrupted { .. }) {
        return Err(nothing());
    }
    note::take_interrupted().ok_or_else(nothing)
}

#[tauri::command]
pub fn speech_check_cancel<R: Runtime>(app: AppHandle<R>) {
    let mut current = lock_status();
    if mark_cancelling(&mut current) {
        app.changed(&current);
    }
}

/// Back to idle: the report is put away, an interrupted run's note too.
#[tauri::command]
pub fn speech_check_dismiss<R: Runtime>(app: AppHandle<R>) {
    let mut current = lock_status();
    if !matches!(*current, Status::Running { .. }) {
        note::remove();
        *current = Status::Idle;
        app.changed(&current);
    }
}

fn start<R: Runtime>(app: AppHandle<R>, plan: Plan, resumed: Option<Note>) -> Result<(), String> {
    let busy = begin(&app)?;
    tauri::async_runtime::spawn(async move {
        let _busy = busy;
        let stopped = AssertUnwindSafe(run(&app, plan.clone(), resumed, &Engines)).catch_unwind().await;
        // Each step is caught on its own (`guarded`); this is the check's own code.
        // The app's engines are not loaded back then: they load on next use.
        if let Err(panic) = stopped {
            STEP_IN_FLIGHT.store(false, Ordering::SeqCst);
            note::remove();
            let reason = format!("The check stopped on an internal error: {}", panic_message(&*panic));
            log::error!("[speech check] {reason}");
            let note = Note::of(plan, Default::default());
            let steps = StepKind::ALL.iter().map(|kind| StepReport::new(*kind, StepStatus::Failed).with_reason(reason.clone())).collect();
            let report = build_report(&note, steps, Outcome::Failed);
            let text = report.render();
            set_status(&app, Status::Finished { report, text });
        }
    });
    Ok(())
}

/// The text of a panic's payload.
fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|text| text.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "no message".into())
}

/// A step that panics fails on its own: the run goes on, gives the engines
/// back, removes the note and finishes, instead of staying Running.
async fn guarded(kind: StepKind, step: impl std::future::Future<Output = StepReport>) -> StepReport {
    match AssertUnwindSafe(step).catch_unwind().await {
        Ok(report) => report,
        Err(panic) => {
            let message = panic_message(&*panic);
            log::error!("[speech check] {} panicked: {message}", kind.title());
            StepReport::new(kind, StepStatus::Failed).with_reason(format!("The step stopped on an internal error: {message}"))
        }
    }
}

/// What a run runs: the engines in the app, stand-ins in tests.
trait Runner: Sync {
    fn system(&self) -> BoxFuture<'_, report::System>;
    fn step<'a>(&'a self, kind: StepKind, plan: &'a Plan, context: &'a steps::Context<'a>) -> BoxFuture<'a, StepReport>;
}

struct Engines;

impl Runner for Engines {
    fn system(&self) -> BoxFuture<'_, report::System> {
        Box::pin(async { tokio::task::spawn_blocking(hardware::system).await.unwrap_or_default() })
    }

    fn step<'a>(&'a self, kind: StepKind, plan: &'a Plan, context: &'a steps::Context<'a>) -> BoxFuture<'a, StepReport> {
        match kind {
            StepKind::Parakeet => Box::pin(steps::parakeet(&plan.live_model, context)),
            StepKind::Whisper => Box::pin(steps::whisper(&plan.post_meeting_model, context)),
            StepKind::Pyannote => Box::pin(steps::pyannote(context)),
            StepKind::Nemotron => Box::pin(steps::nemotron(context)),
        }
    }
}

/// The start under one hold of the status: refused while a check or other
/// speech work runs; otherwise the flags are reset before anything can set
/// them, the busy hold is taken, and Running is emitted at once, so the group
/// shows "Getting ready" with Cancel while the engines are put away.
fn begin(emit: &impl Emit) -> Result<busy::BusyGuard, String> {
    let mut current = lock_status();
    if matches!(*current, Status::Running { .. }) {
        return Err("The speech check is already running".into());
    }
    if let Some(refused) = refusal() {
        return Err(refused);
    }
    CANCEL.store(false, Ordering::SeqCst);
    RECORDING_STARTED.store(false, Ordering::SeqCst);
    let busy = busy::hold(BusyReason::SpeechCheck);
    *current = Status::Running { step: None, steps: StepKind::ALL.to_vec(), done: Vec::new(), cancelling: false };
    emit.changed(&current);
    Ok(busy)
}

/// The app's engines as the check found them.
struct Held {
    whisper: Option<String>,
    parakeet: Option<String>,
    #[cfg(any(windows, target_os = "linux"))]
    backend: Option<crate::whisper_engine::openvino::BackendStatus>,
}

fn app_engines() -> (Option<std::sync::Arc<crate::whisper_engine::WhisperEngine>>, Option<std::sync::Arc<crate::parakeet_engine::ParakeetEngine>>) {
    let whisper = crate::whisper_engine::commands::WHISPER_ENGINE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let parakeet = crate::parakeet_engine::commands::PARAKEET_ENGINE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    (whisper, parakeet)
}

/// Why the check must not take the app's engines now: a recording or other
/// speech work that started after Run, or a Cancel.
fn stop_reason(recording: bool) -> Option<String> {
    if recording || RECORDING_STARTED.load(Ordering::SeqCst) {
        return Some("A recording started".into());
    }
    if CANCEL.load(Ordering::SeqCst) {
        return Some("Cancelled".into());
    }
    refusal()
}

/// Puts the app's idle engines away, under the lifecycle lock. A recording
/// started from the tray or a hotkey just after Run passes the refusal
/// before its `IS_RECORDING` is set; it loads its models under this lock and
/// sets the flag before it lets go, so the check asks again here and leaves
/// those models, and the steps, alone.
async fn take_engines() -> Result<Held, String> {
    let _engines = crate::audio::common::acquire_engine_lifecycle_lock().await;
    if let Some(reason) = stop_reason(crate::audio::recording_commands::is_recording().await) {
        return Err(reason);
    }
    let (whisper, parakeet) = app_engines();
    let held = Held {
        whisper: match &whisper {
            Some(engine) => engine.get_current_model().await,
            None => None,
        },
        parakeet: match &parakeet {
            Some(engine) => engine.get_current_model().await,
            None => None,
        },
        #[cfg(any(windows, target_os = "linux"))]
        backend: crate::whisper_engine::openvino::backend_status(),
    };
    crate::audio::common::unload_both_stt_engines().await;
    // As before every speech model's load: the builtin LLM gives back its memory and GPU.
    crate::audio::common::prepare_for_stt().await;
    Ok(held)
}

/// Loads back what the app's engines held, unless a recording started (it
/// loads what it needs) or something loaded meanwhile.
async fn give_back(held: Held, warnings: &mut Vec<String>) {
    let recording = || RECORDING_STARTED.load(Ordering::SeqCst);
    if recording() || crate::audio::recording_commands::is_recording().await {
        return;
    }
    let _engines = crate::audio::common::acquire_engine_lifecycle_lock().await;
    let (whisper, parakeet) = app_engines();
    if let (Some(engine), Some(model)) = (&parakeet, &held.parakeet) {
        if !recording() && engine.get_current_model().await.is_none() {
            if let Err(error) = engine.load_model(model).await {
                warnings.push(format!("Parakeet {model} did not load again after the check: {error}"));
            }
        }
    }
    let whisper_reload = match (&whisper, &held.whisper) {
        (Some(engine), Some(model)) if !recording() && engine.get_current_model().await.is_none() => Some((engine, model)),
        _ => None,
    };
    if let Some((engine, model)) = whisper_reload {
        if let Err(error) = engine.load_model(model).await {
            warnings.push(format!("Whisper {model} did not load again after the check: {error}"));
        }
    }
    // A reload records its own outcome; otherwise the check's must not stand
    // in Settings for the app's last load.
    #[cfg(any(windows, target_os = "linux"))]
    if whisper_reload.is_none() {
        crate::whisper_engine::openvino::record_status(held.backend.unwrap_or_default());
    }
}

async fn run(emit: &impl Emit, plan: Plan, resumed: Option<Note>, runner: &impl Runner) {
    let taken = take_engines().await;
    if let Err(reason) = &taken {
        log::info!("[speech check] not started: {reason}");
    }
    // A check stopped before its first step does not read the GPUs either.
    let system = match &taken {
        Ok(_) => runner.system().await,
        Err(_) => Default::default(),
    };
    let mut note = match resumed {
        Some(mut note) => {
            note.system = system;
            note
        }
        None => Note::of(plan.clone(), system),
    };
    if note.plan.pair().differs_from(&note.plan.selected()) && !note.warnings.iter().any(|warning| warning.starts_with("The selected models")) {
        note.warnings.push("The selected models differ from the pair Protocol picks for this computer; the check ran the pair".into());
    }
    note::write(&note);
    let to_run: Vec<StepKind> = note.remaining();

    let clips = tokio::task::spawn_blocking(sample::load).await.map_err(|error| anyhow::anyhow!(error.to_string())).and_then(|loaded| loaded);
    let cancelled = || CANCEL.load(Ordering::SeqCst);
    match &clips {
        Ok(clips) => {
            let context = steps::Context { clips, cancelled: &cancelled };
            for kind in to_run {
                // Set before the Cancel is read: a recording that cancels now either
                // sees the flag and waits, or this step sees the Cancel.
                STEP_IN_FLIGHT.store(true, Ordering::SeqCst);
                let report = if let Err(reason) = &taken {
                    StepReport::cancelled(kind, reason)
                } else if cancelled() {
                    StepReport::cancelled(kind, if RECORDING_STARTED.load(Ordering::SeqCst) { "A recording started" } else { "Cancelled" })
                } else {
                    set_running_step(emit, kind, note.done.clone());
                    note.running = Some(kind);
                    note::write(&note);
                    log::info!("[speech check] checking {}", kind.title());
                    let report = guarded(kind, runner.step(kind, &plan, &context)).await;
                    note.running = None;
                    log::info!("[speech check] {}: {:?}", kind.title(), report.status);
                    report
                };
                STEP_IN_FLIGHT.store(false, Ordering::SeqCst);
                note.done.push(report);
                note::write(&note);
            }
        }
        Err(error) => {
            for kind in to_run {
                note.done.push(StepReport::new(kind, StepStatus::Failed).with_reason(format!("The sample did not load: {error}")));
            }
        }
    }
    if let Ok(held) = taken {
        give_back(held, &mut note.warnings).await;
    }
    // The steps in the plan's order, those that closed the app among them.
    let steps = note.done_in_order();
    let mut outcome = Report::outcome_of(&steps);
    // A crash in an earlier start is reported, but it does not make this run
    // interrupted, and the check did not pass.
    if outcome == Outcome::Interrupted {
        let rest: Vec<StepReport> = steps.iter().filter(|step| step.status != StepStatus::ClosedTheApp).cloned().collect();
        outcome = match Report::outcome_of(&rest) {
            Outcome::Passed | Outcome::NothingChecked => Outcome::Failed,
            other => other,
        };
    }
    let report = build_report(&note, steps, outcome);
    note::remove();
    let text = report.render();
    set_status(emit, Status::Finished { report, text });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_interrupted_run_reports_the_step_that_closed_the_app_and_offers_the_rest() {
        let mut note = note::tests::note();
        note.done.push(StepReport::new(StepKind::Parakeet, StepStatus::Passed));
        note.done.push(StepReport::closed(StepKind::Whisper));
        note.closed_in = Some(StepKind::Whisper);
        match interrupted(&note) {
            Status::Interrupted { closed_in, remaining, report, text } => {
                assert_eq!(closed_in, Some(StepKind::Whisper));
                assert_eq!(remaining, vec![StepKind::Pyannote, StepKind::Nemotron]);
                assert_eq!(report.outcome, Outcome::Interrupted);
                assert!(text.contains("Whisper (after the meeting): CLOSED THE APP"), "{text}");
            }
            other => panic!("{other:?}"),
        }
    }

    /// The status and the flags are process-wide: the tests that change them
    /// take turns, and put them back even when they fail.
    static STATICS: Mutex<()> = Mutex::new(());

    pub(super) struct Statics(#[allow(dead_code)] MutexGuard<'static, ()>);

    impl Statics {
        pub(super) fn take() -> Self {
            let turn = STATICS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            reset();
            Statics(turn)
        }
    }

    fn reset() {
        *lock_status() = Status::Idle;
        STEP_IN_FLIGHT.store(false, Ordering::SeqCst);
        CANCEL.store(false, Ordering::SeqCst);
        RECORDING_STARTED.store(false, Ordering::SeqCst);
    }

    impl Drop for Statics {
        fn drop(&mut self) {
            reset();
        }
    }

    /// The statuses a run emitted.
    #[derive(Default)]
    pub(super) struct Events(Mutex<Vec<Status>>);

    impl Emit for Events {
        fn changed(&self, status: &Status) {
            self.0.lock().unwrap().push(status.clone());
        }
    }

    impl Events {
        pub(super) fn all(&self) -> Vec<Status> {
            self.0.lock().unwrap().clone()
        }
    }

    fn running() -> Status {
        Status::Running { step: Some(StepKind::Whisper), steps: StepKind::ALL.to_vec(), done: Vec::new(), cancelling: false }
    }

    #[tokio::test]
    async fn a_recording_start_cancels_a_running_check_only() {
        let _statics = Statics::take();
        cancel_for_recording().await;
        assert!(!CANCEL.load(Ordering::SeqCst), "nothing runs, nothing to cancel");
        *lock_status() = running();
        cancel_for_recording().await;
        assert!(CANCEL.load(Ordering::SeqCst));
        assert!(RECORDING_STARTED.load(Ordering::SeqCst));
        assert!(matches!(status(), Status::Running { cancelling: true, .. }));
    }

    #[test]
    fn only_an_interrupted_check_resumes() {
        let _file = note::tests::FILE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let _statics = Statics::take();
        let folder = tempfile::tempdir().unwrap();
        note::use_path_for_tests(Some(folder.path().join("speech-check.json")));
        let mut left = note::tests::note();
        left.running = Some(StepKind::Whisper);
        note::write(&left);
        // A note on disk while the group shows something else resumes nothing.
        assert_eq!(resumable().err().as_deref(), Some("There is no check to resume"));
        let found = note::take_interrupted().unwrap();
        *lock_status() = interrupted(&found);
        assert_eq!(resumable().unwrap().closed_in, Some(StepKind::Whisper));
        note::remove();
        note::use_path_for_tests(None);
    }

    #[test]
    fn a_cancel_after_the_finish_leaves_the_status_alone() {
        let _statics = Statics::take();
        let finished = Status::Finished { report: build_report(&note::tests::note(), Vec::new(), Outcome::Passed), text: "done".into() };
        *lock_status() = finished.clone();
        assert!(!mark_cancelling(&mut lock_status()));
        assert_eq!(status(), finished);
        assert!(!CANCEL.load(Ordering::SeqCst));
    }

    #[test]
    fn a_cancel_during_a_step_survives_the_next_step_starting() {
        let _statics = Statics::take();
        let events = Events::default();
        *lock_status() = running();
        assert!(mark_cancelling(&mut lock_status()));
        set_running_step(&events, StepKind::Pyannote, vec![StepReport::new(StepKind::Whisper, StepStatus::Cancelled)]);
        match status() {
            Status::Running { step, cancelling, done, .. } => {
                assert_eq!(step, Some(StepKind::Pyannote));
                assert!(cancelling, "a newer step must not undo the Cancel");
                assert_eq!(done.len(), 1);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(events.all().len(), 1);
    }

    #[test]
    fn a_start_resets_the_flags_holds_busy_and_shows_running_at_once() {
        let _statics = Statics::take();
        CANCEL.store(true, Ordering::SeqCst);
        RECORDING_STARTED.store(true, Ordering::SeqCst);
        let events = Events::default();
        let busy = begin(&events).expect("nothing else runs");
        assert!(!CANCEL.load(Ordering::SeqCst));
        assert!(!RECORDING_STARTED.load(Ordering::SeqCst));
        assert!(busy::current().contains(&BusyReason::SpeechCheck));
        assert!(matches!(events.all().as_slice(), [Status::Running { step: None, cancelling: false, .. }]));
        // A recording that starts now finds the check running and cancels it.
        futures::executor::block_on(cancel_for_recording());
        assert!(RECORDING_STARTED.load(Ordering::SeqCst));
        assert_eq!(begin(&events).err().as_deref(), Some("The speech check is already running"));
        drop(busy);
    }

    #[tokio::test]
    async fn the_check_leaves_the_engines_of_a_recording_that_started_after_run() {
        let _statics = Statics::take();
        assert_eq!(stop_reason(true).as_deref(), Some("A recording started"));
        RECORDING_STARTED.store(true, Ordering::SeqCst);
        assert_eq!(stop_reason(false).as_deref(), Some("A recording started"));
        RECORDING_STARTED.store(false, Ordering::SeqCst);
        CANCEL.store(true, Ordering::SeqCst);
        assert_eq!(take_engines().await.err().as_deref(), Some("Cancelled"));
        CANCEL.store(false, Ordering::SeqCst);
        assert_eq!(stop_reason(false), None);
    }

    #[tokio::test]
    async fn a_recording_waits_a_bounded_time_for_the_step_in_flight() {
        let _statics = Statics::take();
        assert!(step_ended_within(Duration::ZERO).await, "no step, no wait");
        STEP_IN_FLIGHT.store(true, Ordering::SeqCst);
        let started = std::time::Instant::now();
        assert!(!step_ended_within(Duration::from_millis(60)).await);
        assert!(started.elapsed() >= Duration::from_millis(60));
        let ends = tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(40)).await;
            STEP_IN_FLIGHT.store(false, Ordering::SeqCst);
        });
        assert!(step_ended_within(Duration::from_secs(5)).await);
        ends.await.unwrap();
    }

    /// Steps that pass, except one that panics.
    struct PanicsIn(StepKind);

    impl Runner for PanicsIn {
        fn system(&self) -> BoxFuture<'_, report::System> {
            Box::pin(async { report::System::default() })
        }

        fn step<'a>(&'a self, kind: StepKind, _plan: &'a Plan, _context: &'a steps::Context<'a>) -> BoxFuture<'a, StepReport> {
            Box::pin(async move {
                if kind == self.0 {
                    panic!("index out of bounds");
                }
                StepReport::new(kind, StepStatus::Passed)
            })
        }
    }

    /// A run on the bundled sample with `runner`, its note in a folder of its own.
    async fn run_on_the_sample(runner: &impl Runner) -> (Vec<Status>, tempfile::TempDir) {
        let resources = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        sample::set_bundled_dir(resources.join("speech-check"));
        let folder = tempfile::tempdir().unwrap();
        note::use_path_for_tests(Some(folder.path().join("speech-check.json")));
        let events = Events::default();
        let plan = Plan::for_tests();
        let _busy = begin(&events).unwrap();
        run(&events, plan, None, runner).await;
        note::use_path_for_tests(None);
        (events.all(), folder)
    }

    #[tokio::test]
    async fn a_step_that_panics_fails_and_the_check_still_finishes() {
        let _file = note::tests::FILE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let _statics = Statics::take();
        let (events, folder) = run_on_the_sample(&PanicsIn(StepKind::Whisper)).await;
        let Some(Status::Finished { report, .. }) = events.last() else { panic!("{events:?}") };
        let statuses: Vec<StepStatus> = report.steps.iter().map(|step| step.status).collect();
        assert_eq!(statuses, vec![StepStatus::Passed, StepStatus::Failed, StepStatus::Passed, StepStatus::Passed]);
        assert_eq!(report.steps[1].reason.as_deref(), Some("The step stopped on an internal error: index out of bounds"));
        assert_eq!(report.outcome, Outcome::Failed);
        assert!(!folder.path().join("speech-check.json").exists(), "the note goes, so the next start claims no crash");
        assert!(!STEP_IN_FLIGHT.load(Ordering::SeqCst));
        assert_eq!(status(), events.last().unwrap().clone());
    }

    #[test]
    fn the_check_refuses_to_run_beside_a_recording_or_a_transcript() {
        let _statics = Statics::take();
        let _recording = busy::hold(BusyReason::Recording);
        assert_eq!(refusal().as_deref(), Some("The speech check can't run during a recording"));
        drop(_recording);
        let _import = busy::hold(BusyReason::Import);
        assert_eq!(refusal().as_deref(), Some("The speech check can't run while a transcript is being made"));
        drop(_import);
        let _summary = busy::hold(BusyReason::Summary);
        assert_eq!(refusal().as_deref(), Some("The speech check can't run while a summary is being written"));
    }

    #[test]
    fn other_speech_work_waits_for_a_running_check() {
        let _statics = Statics::take();
        assert_eq!(refuse_beside("An import"), Ok(()));
        *lock_status() = running();
        assert_eq!(
            refuse_beside("An import").err().as_deref(),
            Some("An import can't start during the speech check. Try again when it ends, or cancel it in Settings › Advanced")
        );
    }

    /// Every step on the models installed in the test binary's data folder
    /// (`<target>/debug/deps/data/models`; link the QA profile's `models`
    /// there), on the bundled sample. Prints the report; `SPEECH_CHECK_WHISPER`
    /// picks the Whisper model (the Compressed copy by default). Run with
    /// `--ignored --nocapture`; docs/SPEECH_CHECK.md says what it shows.
    #[tokio::test]
    #[ignore = "needs installed models in the test binary's data/models (docs/SPEECH_CHECK.md)"]
    async fn every_engine_runs_the_sample_on_the_installed_models() {
        let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).is_test(true).try_init();
        let resources = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
        sample::set_bundled_dir(resources.join("speech-check"));
        crate::diarization::set_bundled_dir(resources.join("diarization"));
        let clips = sample::load().expect("the bundled sample");
        let cancelled = || false;
        let context = steps::Context { clips: &clips, cancelled: &cancelled };
        let whisper = std::env::var("SPEECH_CHECK_WHISPER").unwrap_or_else(|_| "large-v3-turbo-q5_0".into());
        let mut plan = Plan::for_tests();
        plan.post_meeting_model = whisper.clone();
        let steps = vec![
            steps::parakeet(&plan.live_model, &context).await,
            steps::whisper(&whisper, &context).await,
            steps::pyannote(&context).await,
            steps::nemotron(&context).await,
        ];
        let mut note = note::tests::note();
        note.plan = plan.clone();
        note.system = hardware::system();
        let outcome = Report::outcome_of(&steps);
        let report = build_report(&note, steps, outcome);
        println!("{}", report.render());
        for step in &report.steps {
            assert!(matches!(step.status, StepStatus::Passed | StepStatus::NotChecked), "{:?}: {:?}", step.kind, step.reason);
        }
    }

    #[test]
    fn the_plan_names_the_pair_as_settings_saves_models() {
        let plan = Plan::for_tests();
        assert_eq!(plan.pair().live.as_deref(), Some("parakeet:parakeet-tdt-0.6b-v3-int8"));
        assert_eq!(plan.pair().post_meeting.as_deref(), Some("whisper:large-v3-turbo-q5_0"));
        let json = serde_json::json!({"liveModel": "a", "postMeetingModel": "b", "selectedLive": "parakeet:a"});
        let parsed: Plan = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.selected().live.as_deref(), Some("parakeet:a"));
    }
}
