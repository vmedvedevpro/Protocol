//! User quits: tray Quit, and on macOS ⌘Q and Dock Quit (`lib.rs`).
//!
//! While a recording runs, stops, or is being saved, a quit asks first: "A
//! recording is in progress. Stop and save it, then quit?" **Stop and quit**
//! runs the same native Stop as the tray's Stop item, waits until the main
//! window has saved the meeting (`audio::save_handoff`), and then leaves through
//! `updater::quit_app`, which installs a downloaded update only when nothing is
//! busy. **Cancel** leaves the recording running.
//!
//! Without a recording, other work the busy registry reports (`updater::busy`:
//! the post-call pass, a retranscription, a summary, an import, a model
//! download…) asks "Protocol is still busy: … Quit anyway?" first, since the
//! exit would cut it off. Setup being unfinished is not work and does not ask.
//! With nothing busy a quit goes straight to `quit_app`.
//!
//! The WebView owns the meeting and transcript rows, so the exit waits for its
//! answer. A failed or skipped save, or no answer within
//! `save_handoff::ANSWER_WINDOW`, keeps Protocol open and says so: a quit never
//! exits before the save is confirmed.
//!
//! On Unix, SIGTERM and SIGINT (logout, shutdown, `kill`, Ctrl+C in a
//! terminal) are a quit too ([`quit_on_termination_signals`]), and the exit
//! ends in `RunEvent::Exit`, which marks the session clean (`crash_report`).
//! Without this the default action killed the process and the next start
//! reported an unclean shutdown (#121). The first signal asks as tray Quit
//! does, as a courtesy; a second one exits at once, since on a logout nobody
//! answers and the session manager's SIGKILL would follow. A signal never
//! installs a downloaded update on the way out: a logout would kill the
//! installer midway ([`on_signal`]). SIGKILL cannot be caught.
//!
//! One quit runs at a time. Another quit while the question is open or the
//! meeting is being saved only brings the main window forward.

use crate::audio::save_handoff::{self, Handoff, SaveOutcome};
use crate::updater::busy::BusyReason;
use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogBuilder, MessageDialogButtons, MessageDialogKind};

const TITLE: &str = "Protocol";
const QUESTION: &str = "A recording is in progress. Stop and save it, then quit?";
const STOP_AND_QUIT: &str = "Stop and quit";
const CANCEL: &str = "Cancel";
const QUIT_ANYWAY: &str = "Quit anyway";
const NOT_SAVED: &str = "Protocol didn't quit because it couldn't confirm that the recording was saved. Check the meeting list, then quit again.";

/// Recording work a quit must not cut off, read from its owners.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Recording {
    /// Native capture runs (paused included).
    pub running: bool,
    /// Native Stop drains transcription and writes the audio files.
    pub stopping: bool,
    /// The main window saves the meeting that Stop handed over.
    pub saving: bool,
}

impl Recording {
    fn now() -> Self {
        Self {
            running: crate::audio::recording_commands::is_recording_active(),
            stopping: crate::audio::recording_commands::is_stopping(),
            saving: save_handoff::pending(),
        }
    }
}

/// The first busy reason a quit must ask about besides the recording, which
/// [`Recording`] covers with its own question. `Onboarding` only means setup is
/// unfinished; its downloads report `ModelDownload` themselves.
fn other_work(busy: &[BusyReason]) -> Option<BusyReason> {
    busy.iter().copied().find(|reason| {
        !matches!(
            reason,
            BusyReason::Recording | BusyReason::RecordingStopping | BusyReason::RecordingSave | BusyReason::Onboarding
        )
    })
}

fn busy_work() -> Option<BusyReason> {
    other_work(&crate::updater::busy::current())
}

/// The clause after "Protocol is still busy:", worded like the frontend's
/// update sentences (`lib/updateText.ts`).
fn busy_clause(reason: BusyReason) -> &'static str {
    match reason {
        BusyReason::Import => "an audio import is running",
        BusyReason::Retranscription => "a meeting is being retranscribed",
        BusyReason::Diarization => "speakers are being identified",
        BusyReason::Summary => "a summary is being generated",
        BusyReason::PostCall => "a meeting is being processed",
        BusyReason::ModelDownload => "a model is downloading",
        BusyReason::ModelCompile => "a speech model is being prepared for the GPU",
        BusyReason::SpeechCheck => "the speech check is running",
        BusyReason::Recording | BusyReason::RecordingStopping | BusyReason::RecordingSave => {
            "a recording is being saved"
        }
        BusyReason::Onboarding | BusyReason::SpeechEngine => "the speech engine is busy",
    }
}

fn busy_question(reason: BusyReason) -> String {
    format!(
        "Protocol is still busy: {}. If you quit now, it stops and its progress is lost. Quit anyway?",
        busy_clause(reason)
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Plan {
    /// Nothing to save and nothing to install: exit.
    Exit,
    /// Nothing to save and a downloaded update: `quit_app` installs it when
    /// nothing else is busy, then exits.
    Install,
    /// Ask; on Stop and quit, stop the recording and wait for its save.
    StopAndSave,
    /// Ask; on Stop and quit, wait for the Stop or the save already under way.
    WaitForSave,
    /// Ask; on Quit anyway, leave and cut the work off.
    Busy(BusyReason),
}

pub(crate) fn plan(recording: Recording, busy: Option<BusyReason>, update_ready: bool) -> Plan {
    if recording.running && !recording.stopping {
        Plan::StopAndSave
    } else if recording.stopping || recording.saving {
        Plan::WaitForSave
    } else if let Some(reason) = busy {
        Plan::Busy(reason)
    } else if update_ready {
        Plan::Install
    } else {
        Plan::Exit
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Flow {
    Idle,
    /// The question is open.
    Asking,
    /// The user chose Stop and quit; the recording is stopped and saved.
    Saving,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    /// Leave through `updater::quit_app`.
    Quit,
    Ask,
    /// A quit already asks or saves: no second question, no second Stop.
    BringForward,
}

pub(crate) fn action(flow: Flow, plan: Plan) -> Action {
    match (flow, plan) {
        (Flow::Asking | Flow::Saving, _) => Action::BringForward,
        (Flow::Idle, Plan::Exit | Plan::Install) => Action::Quit,
        (Flow::Idle, Plan::StopAndSave | Plan::WaitForSave | Plan::Busy(_)) => Action::Ask,
    }
}

/// What a termination signal does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SignalStep {
    /// The quit's questions, as tray Quit asks them; `install` is whether
    /// the exit may install a downloaded update.
    Request { install: bool },
    /// Exit now, without asking and without installing.
    Exit,
}

/// The first signal asks (a courtesy); a second one, `signalled` before,
/// quits while the question is open. Neither installs an update.
pub(crate) fn on_signal(signalled: bool) -> SignalStep {
    if signalled {
        SignalStep::Exit
    } else {
        SignalStep::Request { install: false }
    }
}

/// Whether a quit that saved the recording asks again: only for a recording
/// started meanwhile. Other busy work does not ask again, since the user
/// already chose to quit.
pub(crate) fn asks_again_after_save(next: Plan) -> bool {
    matches!(next, Plan::StopAndSave | Plan::WaitForSave)
}

/// Whether a macOS ⌘Q or Dock Quit must be held back for [`request`]: only an
/// idle app with nothing to install exits without it.
pub(crate) fn holds(flow: Flow, plan: Plan) -> bool {
    !(flow == Flow::Idle && plan == Plan::Exit)
}

/// What the quit does once the save has settled.
pub(crate) fn after_save(handoff: Handoff) -> Result<(), String> {
    match handoff {
        Handoff::Finished(SaveOutcome::Saved | SaveOutcome::Discarded) | Handoff::NoStop => Ok(()),
        Handoff::Finished(outcome) => Err(format!("the main window reported {outcome:?}")),
        Handoff::Unanswered => Err("the main window did not answer".into()),
        Handoff::Pending => Err("the save is still running".into()),
    }
}

static FLOW: Mutex<Flow> = Mutex::new(Flow::Idle);

fn flow() -> MutexGuard<'static, Flow> {
    FLOW.lock().unwrap_or_else(PoisonError::into_inner)
}

fn set_flow(next: Flow) {
    *flow() = next;
}

/// The user chose Stop and quit and the meeting is being saved: the WebView
/// does not open it, so no post-call processing starts that the exit would
/// cut off.
pub fn saving_to_quit() -> bool {
    *flow() == Flow::Saving
}

pub fn holds_exit<R: Runtime>(app: &AppHandle<R>) -> bool {
    !crate::updater::is_quitting()
        && holds(*flow(), plan(Recording::now(), busy_work(), crate::updater::installs_on_quit(app)))
}

/// Tray Quit, and on macOS ⌘Q and Dock Quit.
pub fn request<R: Runtime>(app: &AppHandle<R>) {
    request_with(app, true);
}

/// The exit: through `updater::quit_app`, which installs a downloaded update
/// when nothing is busy, or straight out when `install` is false.
fn leave<R: Runtime>(app: &AppHandle<R>, install: bool) {
    if install {
        crate::updater::quit_app(app);
    } else {
        app.exit(0);
    }
}

fn request_with<R: Runtime>(app: &AppHandle<R>, install: bool) {
    if crate::updater::is_quitting() {
        // The exit is already under way (an update installs on quit).
        crate::updater::quit_app(app);
        return;
    }
    let plan = plan(Recording::now(), busy_work(), install && crate::updater::installs_on_quit(app));
    let action = {
        let mut flow = flow();
        let action = action(*flow, plan);
        if action == Action::Ask {
            *flow = Flow::Asking;
        }
        action
    };
    match action {
        Action::Quit => leave(app, install),
        Action::BringForward => {
            log::info!("[quit] a quit is already asking or saving");
            crate::tray::focus_main_window(app);
        }
        Action::Ask => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { confirm_and_quit(app, install).await });
        }
    }
}

/// Routes SIGTERM and SIGINT to the quit for the app's lifetime ([`on_signal`]).
#[cfg(unix)]
pub fn quit_on_termination_signals<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let (mut terminate, mut interrupt) = match (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) {
            (Ok(terminate), Ok(interrupt)) => (terminate, interrupt),
            (Err(error), _) | (_, Err(error)) => {
                log::warn!("[quit] cannot listen for termination signals: {error}");
                return;
            }
        };
        let mut signalled = false;
        loop {
            let name = tokio::select! {
                _ = terminate.recv() => "SIGTERM",
                _ = interrupt.recv() => "SIGINT",
            };
            match on_signal(signalled) {
                SignalStep::Request { install } => {
                    log::info!("[quit] {name}: quitting as from the tray");
                    request_with(&app, install);
                }
                SignalStep::Exit => {
                    log::info!("[quit] {name} again: quitting now");
                    app.exit(0);
                }
            }
            signalled = true;
        }
    });
}

async fn confirm_and_quit<R: Runtime>(app: AppHandle<R>, install: bool) {
    loop {
        bring_forward(&app).await;
        // Read again on every round: the work may have ended or started
        // (meeting detection can start a recording while the last one is saved).
        match plan(Recording::now(), busy_work(), false) {
            Plan::StopAndSave | Plan::WaitForSave => {
                if !ask(&app, QUESTION, STOP_AND_QUIT).await {
                    log::info!("[quit] cancelled; the recording goes on");
                    set_flow(Flow::Idle);
                    return;
                }
                set_flow(Flow::Saving);
                if let Err(problem) = stop_and_save(&app).await {
                    log::warn!("[quit] staying open: {problem}");
                    set_flow(Flow::Idle);
                    tell(&app, NOT_SAVED).await;
                    return;
                }
                log::info!("[quit] the recording is saved");
                if !asks_again_after_save(plan(Recording::now(), None, false)) {
                    break;
                }
                set_flow(Flow::Asking);
            }
            Plan::Busy(reason) => {
                if !ask(&app, &busy_question(reason), QUIT_ANYWAY).await {
                    log::info!("[quit] cancelled; {reason:?} goes on");
                    set_flow(Flow::Idle);
                    return;
                }
                log::info!("[quit] quitting during {reason:?}");
                break;
            }
            Plan::Exit | Plan::Install => break,
        }
    }
    leave(&app, install);
}

/// The question must be visible while the window is hidden in the tray or
/// replaced by the compact bar, and the save's progress shows in the window.
async fn bring_forward<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = crate::minibar::exit_compact_mode(app.clone()).await {
        log::warn!("[quit] could not leave compact mode: {error}");
    }
    crate::tray::focus_main_window(app);
}

async fn stop_and_save<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if plan(Recording::now(), None, false) == Plan::StopAndSave {
        stop(app).await?;
    }
    // A Stop from the window, the tray or the compact bar may still run; it
    // hands the meeting over before it ends.
    while crate::audio::recording_commands::is_stopping() {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    after_save(save_handoff::wait().await)
}

/// The tray's Stop: the same native graceful stop as every other Stop.
async fn stop<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    use crate::audio::recording_commands::{stop_recording, RecordingArgs};
    crate::tray::set_tray_state(app, crate::tray::RecordingState::Stopping);
    let timestamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let save_path = crate::paths::install_data_root().join(format!("recording-{timestamp}.wav"));
    let args = RecordingArgs {
        save_path: save_path.to_string_lossy().to_string(),
    };
    match stop_recording(app.clone(), args).await {
        Ok(outcome) => {
            log::info!("[quit] stop: {outcome:?}");
            Ok(())
        }
        Err(error) => {
            crate::tray::update_tray_menu_async(app).await;
            Err(format!("the recording did not stop: {error}"))
        }
    }
}

fn dialog<R: Runtime>(app: &AppHandle<R>, text: &str) -> MessageDialogBuilder<R> {
    let dialog = app.dialog().message(text).title(TITLE).kind(MessageDialogKind::Warning);
    match app.get_webview_window("main") {
        Some(main) => dialog.parent(&main),
        None => dialog,
    }
}

/// True for the quit button; Cancel, Escape and closing the dialog say no.
async fn ask<R: Runtime>(app: &AppHandle<R>, question: &str, quit: &str) -> bool {
    let (answer, answered) = tokio::sync::oneshot::channel();
    dialog(app, question)
        .buttons(MessageDialogButtons::OkCancelCustom(quit.into(), CANCEL.into()))
        .show(move |confirmed| {
            let _ = answer.send(confirmed);
        });
    answered.await.unwrap_or(false)
}

async fn tell<R: Runtime>(app: &AppHandle<R>, text: &str) {
    let (done, closed) = tokio::sync::oneshot::channel();
    dialog(app, text).buttons(MessageDialogButtons::Ok).show(move |_| {
        let _ = done.send(());
    });
    let _ = closed.await;
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDLE: Recording = Recording { running: false, stopping: false, saving: false };
    const RUNNING: Recording = Recording { running: true, stopping: false, saving: false };
    const STOPPING: Recording = Recording { running: true, stopping: true, saving: false };
    const SAVING: Recording = Recording { running: false, stopping: false, saving: true };

    #[test]
    fn recording_work_asks_first_and_an_update_never_skips_the_question() {
        for update_ready in [false, true] {
            for busy in [None, Some(BusyReason::PostCall)] {
                assert_eq!(plan(RUNNING, busy, update_ready), Plan::StopAndSave);
                assert_eq!(plan(STOPPING, busy, update_ready), Plan::WaitForSave);
                assert_eq!(plan(SAVING, busy, update_ready), Plan::WaitForSave);
            }
        }
        assert_eq!(plan(IDLE, None, false), Plan::Exit);
        assert_eq!(plan(IDLE, None, true), Plan::Install);
    }

    #[test]
    fn busy_work_without_a_recording_asks_before_the_exit_cuts_it_off() {
        // #121: tray Quit during the post-call pass quit at once.
        for update_ready in [false, true] {
            assert_eq!(
                plan(IDLE, Some(BusyReason::Retranscription), update_ready),
                Plan::Busy(BusyReason::Retranscription)
            );
        }
        assert_eq!(action(Flow::Idle, Plan::Busy(BusyReason::Summary)), Action::Ask);
        assert!(holds(Flow::Idle, Plan::Busy(BusyReason::Summary)), "macOS ⌘Q asks too");
    }

    #[test]
    fn only_work_the_recording_question_does_not_cover_counts_as_busy() {
        use BusyReason::*;
        assert_eq!(other_work(&[]), None);
        assert_eq!(other_work(&[Onboarding]), None, "unfinished setup is not work");
        assert_eq!(other_work(&[Recording, RecordingStopping, RecordingSave]), None);
        assert_eq!(other_work(&[Recording, PostCall, ModelDownload]), Some(PostCall));
        assert_eq!(other_work(&[Onboarding, ModelDownload]), Some(ModelDownload));
        for reason in [Import, Retranscription, Diarization, Summary, PostCall, ModelDownload, ModelCompile] {
            assert!(busy_question(reason).contains(busy_clause(reason)));
        }
    }

    #[test]
    fn a_stop_already_running_is_waited_for_and_never_started_twice() {
        // The stop's drain can outlive the capture flag.
        let draining = Recording { running: false, stopping: true, saving: false };
        assert_eq!(plan(draining, None, false), Plan::WaitForSave);
        // A new recording while the last meeting is still saved is stopped too.
        let new_recording = Recording { running: true, stopping: false, saving: true };
        assert_eq!(plan(new_recording, None, false), Plan::StopAndSave);
    }

    #[test]
    fn a_second_signal_quits_and_no_signal_installs_an_update() {
        assert_eq!(on_signal(false), SignalStep::Request { install: false });
        assert_eq!(on_signal(true), SignalStep::Exit);
    }

    #[test]
    fn after_stop_and_quit_only_a_new_recording_asks_again() {
        assert!(asks_again_after_save(Plan::StopAndSave), "meeting detection started one");
        assert!(asks_again_after_save(Plan::WaitForSave));
        for next in [Plan::Exit, Plan::Install, Plan::Busy(BusyReason::PostCall), Plan::Busy(BusyReason::ModelDownload)] {
            assert!(!asks_again_after_save(next), "{next:?}");
        }
    }

    #[test]
    fn a_second_quit_neither_asks_again_nor_stops_again() {
        for plan in [Plan::Exit, Plan::Install, Plan::StopAndSave, Plan::WaitForSave, Plan::Busy(BusyReason::Import)] {
            assert_eq!(action(Flow::Asking, plan), Action::BringForward);
            assert_eq!(action(Flow::Saving, plan), Action::BringForward);
        }
        assert_eq!(action(Flow::Idle, Plan::Exit), Action::Quit);
        assert_eq!(action(Flow::Idle, Plan::Install), Action::Quit);
        assert_eq!(action(Flow::Idle, Plan::StopAndSave), Action::Ask);
        assert_eq!(action(Flow::Idle, Plan::WaitForSave), Action::Ask);
    }

    #[test]
    fn macos_lets_only_a_plain_quit_through() {
        assert!(!holds(Flow::Idle, Plan::Exit));
        assert!(holds(Flow::Idle, Plan::Install));
        assert!(holds(Flow::Idle, Plan::StopAndSave));
        assert!(holds(Flow::Idle, Plan::WaitForSave));
        assert!(holds(Flow::Asking, Plan::Exit), "a second ⌘Q while asking");
        assert!(holds(Flow::Saving, Plan::Exit), "a second ⌘Q while saving");
    }

    #[test]
    fn the_app_exits_only_after_a_confirmed_save() {
        assert!(after_save(Handoff::Finished(SaveOutcome::Saved)).is_ok());
        assert!(after_save(Handoff::Finished(SaveOutcome::Discarded)).is_ok());
        assert!(after_save(Handoff::NoStop).is_ok());
        assert!(after_save(Handoff::Finished(SaveOutcome::Failed)).is_err());
        assert!(after_save(Handoff::Finished(SaveOutcome::NotSaved)).is_err());
        assert!(after_save(Handoff::Unanswered).is_err());
        assert!(after_save(Handoff::Pending).is_err());
    }
}
