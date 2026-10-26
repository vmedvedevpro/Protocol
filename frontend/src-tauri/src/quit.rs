//! User quits: tray Quit, and on macOS ⌘Q and Dock Quit (`lib.rs`).
//!
//! While a recording runs, stops, or is being saved, a quit asks first: "A
//! recording is in progress. Stop and save it, then quit?" **Stop and quit**
//! runs the same native Stop as the tray's Stop item, waits until the main
//! window has saved the meeting (`audio::save_handoff`), and then leaves through
//! `updater::quit_app`, which installs a downloaded update only when nothing is
//! busy. **Cancel** leaves the recording running. Without a recording a quit
//! goes straight to `quit_app`, as before.
//!
//! The WebView owns the meeting and transcript rows, so the exit waits for its
//! answer. A failed or skipped save, or no answer within
//! `save_handoff::ANSWER_WINDOW`, keeps Protocol open and says so: a quit never
//! exits before the save is confirmed.
//!
//! One quit runs at a time. Another quit while the question is open or the
//! meeting is being saved only brings the main window forward.

use crate::audio::save_handoff::{self, Handoff, SaveOutcome};
use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogBuilder, MessageDialogButtons, MessageDialogKind};

const TITLE: &str = "Protocol";
const QUESTION: &str = "A recording is in progress. Stop and save it, then quit?";
const STOP_AND_QUIT: &str = "Stop and quit";
const CANCEL: &str = "Cancel";
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
}

pub(crate) fn plan(recording: Recording, update_ready: bool) -> Plan {
    if recording.running && !recording.stopping {
        Plan::StopAndSave
    } else if recording.stopping || recording.saving {
        Plan::WaitForSave
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
        (Flow::Idle, Plan::StopAndSave | Plan::WaitForSave) => Action::Ask,
    }
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
        && holds(*flow(), plan(Recording::now(), crate::updater::installs_on_quit(app)))
}

/// Tray Quit, and on macOS ⌘Q and Dock Quit.
pub fn request<R: Runtime>(app: &AppHandle<R>) {
    if crate::updater::is_quitting() {
        // The exit is already under way (an update installs on quit).
        crate::updater::quit_app(app);
        return;
    }
    let plan = plan(Recording::now(), crate::updater::installs_on_quit(app));
    let action = {
        let mut flow = flow();
        let action = action(*flow, plan);
        if action == Action::Ask {
            *flow = Flow::Asking;
        }
        action
    };
    match action {
        Action::Quit => crate::updater::quit_app(app),
        Action::BringForward => {
            log::info!("[quit] a quit is already asking or saving");
            crate::tray::focus_main_window(app);
        }
        Action::Ask => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { confirm_and_quit(app).await });
        }
    }
}

async fn confirm_and_quit<R: Runtime>(app: AppHandle<R>) {
    loop {
        bring_forward(&app).await;
        if !ask(&app).await {
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
        // Meeting detection can start a recording while the last one is saved.
        if !matches!(plan(Recording::now(), false), Plan::StopAndSave | Plan::WaitForSave) {
            break;
        }
        set_flow(Flow::Asking);
    }
    log::info!("[quit] the recording is saved; quitting");
    crate::updater::quit_app(&app);
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
    if plan(Recording::now(), false) == Plan::StopAndSave {
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

/// True for Stop and quit; Cancel, Escape and closing the dialog say no.
async fn ask<R: Runtime>(app: &AppHandle<R>) -> bool {
    let (answer, answered) = tokio::sync::oneshot::channel();
    dialog(app, QUESTION)
        .buttons(MessageDialogButtons::OkCancelCustom(STOP_AND_QUIT.into(), CANCEL.into()))
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
    fn only_recording_work_asks_and_an_update_never_skips_the_question() {
        for update_ready in [false, true] {
            assert_eq!(plan(RUNNING, update_ready), Plan::StopAndSave);
            assert_eq!(plan(STOPPING, update_ready), Plan::WaitForSave);
            assert_eq!(plan(SAVING, update_ready), Plan::WaitForSave);
        }
        assert_eq!(plan(IDLE, false), Plan::Exit);
        assert_eq!(plan(IDLE, true), Plan::Install);
    }

    #[test]
    fn a_stop_already_running_is_waited_for_and_never_started_twice() {
        // The stop's drain can outlive the capture flag.
        let draining = Recording { running: false, stopping: true, saving: false };
        assert_eq!(plan(draining, false), Plan::WaitForSave);
        // A new recording while the last meeting is still saved is stopped too.
        let new_recording = Recording { running: true, stopping: false, saving: true };
        assert_eq!(plan(new_recording, false), Plan::StopAndSave);
    }

    #[test]
    fn a_second_quit_neither_asks_again_nor_stops_again() {
        for plan in [Plan::Exit, Plan::Install, Plan::StopAndSave, Plan::WaitForSave] {
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
