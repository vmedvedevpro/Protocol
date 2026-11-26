//! Keep on top for the main window and the minibar on Linux (#199), and the
//! minimize that opens the minibar during a recording on KDE Plasma's
//! Wayland.
//!
//! Tauri's `set_always_on_top` ends in GTK3's `gtk_window_set_keep_above`,
//! which works on X11 (an EWMH state the window manager honours) and does
//! nothing on Wayland, where no protocol lets a client keep its window above
//! others. So the route depends on the session, found once at start
//! ([`init`]):
//! - X11 (any desktop, XWayland included): Tauri's call, as before.
//! - Wayland under KWin (KDE Plasma): KWin runs scripts sent over D-Bus
//!   (`org.kde.KWin /Scripting`), and a script may set `keepAbove` on a
//!   window. [`apply_kwin`] loads one for this process's windows.
//! - Other Wayland compositors (GNOME, wlroots): none. The title bar says so
//!   where the pin would be ([`linux_keep_on_top_available`]); GNOME offers
//!   Always on Top in the native frame's window menu instead. The minibar uses
//!   layer-shell where the compositor has it (`layer_shell.rs`), else it is a
//!   plain window and the bar says once that it cannot stay on top.
//!
//! The script is loaded only while something needs it: the pin, a minibar
//! kept above through KWin, or a recording (whose minimize KWin reports, see
//! below). It is reloaded with the new state on each change and unloaded when
//! nothing needs it and at exit ([`unload_kwin_script`]). KWin forgets a
//! Wayland window when it is unmapped, and the main window is hidden while
//! the minibar shows, so a loaded script also applies to windows added later.
//!
//! The script reports back over D-Bus to an object this process exports on
//! GLib's shared session-bus connection ([`register_callback`]):
//! - `Raised`/`Released`: the windows whose Keep Above the script turned on
//!   and the user has not turned off since. When the pin goes off only those
//!   are cleared, so a Keep Above the user set from KWin's window menu stays.
//! - `Minimized`: the main window was minimized. Wayland tells a client
//!   nothing when its window is minimized (xdg-shell has no such state, and
//!   GDK3 never sets `GDK_WINDOW_STATE_ICONIFIED` there: GTK issue 67), so
//!   lib.rs' minimize-to-minibar, which reads tao's `is_minimized`, never
//!   fires on Wayland. KWin's `minimizedChanged` does.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::Duration;

use dbus::blocking::Connection;
use gtk::gio;
use gtk::glib::{self, ToVariant};
use gtk::prelude::*;
use tauri::{AppHandle, Emitter, Manager, Runtime};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Route {
    /// X11: GTK's keep-above, through Tauri.
    Window,
    /// Wayland under KWin: a KWin script.
    KWin,
    /// Wayland elsewhere: nothing a client can do.
    None,
}

static ROUTE: OnceLock<Route> = OnceLock::new();

/// The route found at start; `None` before [`init`] ran.
pub fn route() -> Route {
    ROUTE.get().copied().unwrap_or(Route::None)
}

/// Whether GDK runs on Wayland. Main thread only.
pub fn is_wayland() -> bool {
    gtk::gdk::Display::default().is_some_and(|display| display.backend().is_wayland())
}

fn kwin_on_bus() -> bool {
    let has_owner = || -> Result<bool, dbus::Error> {
        let connection = Connection::new_session()?;
        let proxy = connection.with_proxy(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            Duration::from_secs(2),
        );
        let (owned,): (bool,) =
            proxy.method_call("org.freedesktop.DBus", "NameHasOwner", ("org.kde.KWin",))?;
        Ok(owned)
    };
    has_owner().unwrap_or_else(|error| {
        log::warn!("Linux keep on top: cannot ask the session bus for KWin ({error})");
        false
    })
}

/// The app, for the script's `Minimized` report.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Finds the route. Runs in Tauri's setup, on the main thread, before any
/// window asks; the D-Bus object's handlers then run on this thread too.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let route = if !is_wayland() {
        Route::Window
    } else if !kwin_on_bus() {
        Route::None
    } else {
        // The script needs the object to report to: without it the pin
        // could not be undone on the windows it raised.
        match register_callback() {
            Ok(service) => {
                let _ = CALLBACK_SERVICE.set(service);
                Route::KWin
            }
            Err(error) => {
                log::warn!("Linux keep on top: KWin is running, but its script cannot report back ({error})");
                Route::None
            }
        }
    };
    log::info!("Linux keep on top: {route:?}");
    let _ = ROUTE.set(route);
}

// ---------------------------------------------------------------------------
// The object the script reports to
// ---------------------------------------------------------------------------

const CALLBACK_PATH: &str = "/io/github/vmedvedevpro/Protocol/KWinScript";
const CALLBACK_INTERFACE: &str = "io.github.vmedvedevpro.Protocol.KWinScript";
const CALLBACK_XML: &str = r#"<node>
  <interface name="io.github.vmedvedevpro.Protocol.KWinScript">
    <method name="Raised"><arg type="s" name="window" direction="in"/></method>
    <method name="Released"><arg type="s" name="window" direction="in"/></method>
    <method name="Minimized"><arg type="s" name="window" direction="in"/></method>
  </interface>
</node>"#;

/// This process's unique name on the session bus, where the script calls.
static CALLBACK_SERVICE: OnceLock<String> = OnceLock::new();

/// KWin's internal ids of the main windows whose Keep Above the script turned
/// on, and the user has not turned off since. Written by the D-Bus handlers
/// (main thread), taken by [`apply_kwin`] when the pin goes off.
static RAISED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// KWin's unique name, the only caller the object answers.
static KWIN_OWNER: Mutex<Option<String>> = Mutex::new(None);

fn raised() -> std::sync::MutexGuard<'static, HashSet<String>> {
    RAISED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn is_kwin(connection: &gio::DBusConnection, sender: &str) -> bool {
    let mut owner = KWIN_OWNER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if owner.as_deref() == Some(sender) {
        return true;
    }
    // First call, or KWin restarted under a new name.
    let reply = connection.call_sync(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
        "GetNameOwner",
        Some(&("org.kde.KWin",).to_variant()),
        Some(glib::VariantTy::new("(s)").expect("a valid type")),
        gio::DBusCallFlags::NONE,
        1000,
        gio::Cancellable::NONE,
    );
    *owner = reply.ok().and_then(|reply| reply.child_value(0).str().map(str::to_owned));
    owner.as_deref() == Some(sender)
}

fn on_report(method: &str, window: String) {
    match method {
        "Raised" => {
            raised().insert(window);
        }
        "Released" => {
            raised().remove(&window);
        }
        "Minimized" => {
            if !crate::audio::recording_commands::is_recording_active() {
                return;
            }
            log::info!("Linux minibar: KWin minimized the main window during a recording");
            if let Some(app) = APP.get() {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::minibar::enter_compact_mode(app, None).await {
                        log::warn!("Linux minibar: cannot open it after the minimize ({error})");
                    }
                });
            }
        }
        _ => {}
    }
}

/// Exports the object on GLib's shared session-bus connection and returns
/// the connection's unique name. Main thread: GDBus runs the handlers in the
/// thread-default main context of the thread that registers, here GTK's.
fn register_callback() -> Result<String, String> {
    let connection = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE)
        .map_err(|error| format!("no session bus: {error}"))?;
    let node = gio::DBusNodeInfo::for_xml(CALLBACK_XML).map_err(|error| error.to_string())?;
    let interface = node
        .lookup_interface(CALLBACK_INTERFACE)
        .ok_or("the interface is missing from its XML")?;
    // The registration lives as long as the connection, the process's.
    connection
        .register_object(
            CALLBACK_PATH,
            &interface,
            |connection, sender, _path, _interface, method, parameters, invocation| {
                if !is_kwin(&connection, sender) {
                    invocation.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "Only KWin reports here");
                    return;
                }
                if let Some(window) = parameters.child_value(0).str().map(str::to_owned) {
                    on_report(method, window);
                }
                invocation.return_value(None);
            },
            // The interface has no properties.
            |_, _, _, _, _| ().to_variant(),
            |_, _, _, _, _, _| false,
        )
        .map_err(|error| format!("cannot export {CALLBACK_PATH}: {error}"))?;
    connection
        .unique_name()
        .map(|name| name.to_string())
        .ok_or_else(|| "the session-bus connection has no unique name".into())
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

// What the script applies. The pin's state; the minibar's is set while it
// exists and has no layer-shell surface; the minimize is watched while a
// recording runs.
static MAIN_ABOVE: AtomicBool = AtomicBool::new(false);
static MINIBAR_ABOVE: AtomicBool = AtomicBool::new(false);
static WATCH_MINIMIZE: AtomicBool = AtomicBool::new(false);

/// Whether a script of ours is loaded in KWin, and whether the app is
/// exiting. The lock also serializes reloads, so two changes cannot
/// interleave their unload and load, and none lands after the exit's unload.
struct ScriptState {
    loaded: bool,
    closed: bool,
}

static KWIN_SCRIPT: Mutex<ScriptState> = Mutex::new(ScriptState { loaded: false, closed: false });

/// The minibar's title (`minibar.rs`), by which the script tells it from the
/// main window: both belong to this process and Wayland has no
/// skip-taskbar hint for KWin to read.
pub const MINIBAR_TITLE: &str = "Recording";

fn plugin_name() -> String {
    // One script per app: a fixed name lets a new start replace a script a
    // crashed run left loaded. The program name differs between Protocol and
    // a QA build, so one does not unload the other's.
    format!(
        "{}-keep-above",
        glib::prgname().map(|name| name.to_string()).unwrap_or_else(|| "protocol".into())
    )
}

/// What one load of the script does.
#[derive(Debug, Default)]
struct Spec {
    pid: u32,
    /// The pin is on: raise the main windows.
    main: bool,
    /// Keep the minibar above and put it top centre.
    minibar: bool,
    /// Report the main window's minimize.
    watch_minimize: bool,
    /// The pin went off: clear Keep Above on these windows, which an earlier
    /// load raised.
    release: Vec<String>,
    /// The pin stays on: the windows an earlier load raised, whose Keep
    /// Above this load finds on and must still follow.
    raised: Vec<String>,
    /// Where the script reports (this process's unique bus name).
    service: String,
}

/// The script for `spec`, or none when it has nothing to do.
fn script(spec: &Spec) -> Option<String> {
    let watches = spec.main || spec.minibar || spec.watch_minimize;
    if !watches && spec.release.is_empty() {
        return None;
    }
    let json = |value: &str| serde_json::to_string(value).expect("a string serializes");
    let mut js = format!(
        r#"// Written by Protocol (src/linux_desktop/keep_above.rs).
const pid = {pid};
function ours(w) {{ return w.pid === pid && w.normalWindow; }}
function isBar(w) {{ return w.caption === {title}; }}
function report(method, w) {{
    callDBus({service}, {path}, {interface}, method, String(w.internalId));
}}
// Plasma 6 names them windowList/windowAdded, Plasma 5 clientList/clientAdded.
const windows = workspace.windowList ? workspace.windowList() : workspace.clientList();
"#,
        pid = spec.pid,
        title = json(MINIBAR_TITLE),
        service = json(&spec.service),
        path = json(CALLBACK_PATH),
        interface = json(CALLBACK_INTERFACE),
    );
    if !spec.release.is_empty() {
        let ids = serde_json::to_string(&spec.release).expect("strings serialize");
        js.push_str(&format!(
            r#"// The pin went off: clear Keep Above where an earlier load set it.
const release = {ids};
for (const w of windows) {{
    if (ours(w) && !isBar(w) && release.includes(String(w.internalId))) w.keepAbove = false;
}}
"#
        ));
    }
    if !watches {
        return Some(js);
    }
    js.push_str("function apply(w, added) {\n    if (!ours(w)) return;\n    if (isBar(w)) {\n");
    if spec.minibar {
        js.push_str(
            r#"        w.keepAbove = true;
        // A new bar: just added, or shown before this load ran (KWin forgets
        // an unmapped window, so a new one has skipTaskbar unset). A bar this
        // script placed keeps where the user dragged it.
        if (added || !w.skipTaskbar) {
            // Wayland lets no client place its window; put the bar top centre.
            w.skipTaskbar = true;
            w.skipSwitcher = true;
            const area = workspace.clientArea(KWin.PlacementArea, w);
            const g = w.frameGeometry;
            w.frameGeometry = {x: area.x + Math.round((area.width - g.width) / 2), y: area.y + 12,
                width: g.width, height: g.height};
        }
"#,
        );
    }
    js.push_str("        return;\n    }\n");
    if spec.main {
        let raised = serde_json::to_string(&spec.raised).expect("strings serialize");
        js.push_str(&format!(
            r#"    // A Keep Above the user set is theirs: leave it, and do not report it.
    const raised = {raised};
    const follow = () => w.keepAboveChanged.connect(() => {{ if (!w.keepAbove) report("Released", w); }});
    if (!w.keepAbove) {{
        w.keepAbove = true;
        report("Raised", w);
        follow();
    }} else if (raised.includes(String(w.internalId))) {{
        follow();
    }}
"#
        ));
    }
    if spec.watch_minimize {
        js.push_str(
            r#"    // Wayland does not tell the app; the app opens the minibar.
    w.minimizedChanged.connect(() => { if (w.minimized) report("Minimized", w); });
"#,
        );
    }
    js.push_str(
        r#"}
for (const w of windows) apply(w, false);
(workspace.windowAdded || workspace.clientAdded).connect(w => apply(w, true));
"#,
    );
    Some(js)
}

fn kwin_call<A: dbus::arg::AppendAll, R: dbus::arg::ReadAll>(
    connection: &Connection,
    path: &str,
    interface: &str,
    method: &str,
    args: A,
) -> Result<R, dbus::Error> {
    connection
        .with_proxy("org.kde.KWin", path, Duration::from_secs(2))
        .method_call(interface, method, args)
}

fn unload(connection: &Connection, name: &str) -> Result<(), String> {
    let _: (bool,) = kwin_call(connection, "/Scripting", "org.kde.kwin.Scripting", "unloadScript", (name,))
        .map_err(|error| format!("KWin unloadScript: {error}"))?;
    Ok(())
}

/// Writes the script where KWin reads it: the user's runtime directory,
/// private to the user (0700 by the XDG spec). No fallback to a shared
/// directory such as /tmp, where another user could plant a symlink.
fn write_script(name: &str, text: &str) -> Result<std::path::PathBuf, String> {
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|dir| !dir.is_empty())
        .ok_or("XDG_RUNTIME_DIR is not set, so there is no private place for the KWin script")?;
    let path = std::path::PathBuf::from(dir).join(format!("{name}.js"));
    std::fs::write(&path, text)
        .map_err(|error| format!("cannot write the KWin script {}: {error}", path.display()))?;
    Ok(path)
}

/// Loads the script for the current state in place of the one before, or
/// unloads it when nothing needs it. Blocks on D-Bus; call it off the main
/// thread.
fn apply_kwin() -> Result<(), String> {
    let mut state = KWIN_SCRIPT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.closed {
        return Ok(());
    }
    let main = MAIN_ABOVE.load(Ordering::SeqCst);
    // Taken under the lock: a `Raised` the old script sends after this load
    // read the set would be lost (a window raised and unpinned within the
    // same few milliseconds).
    let (release, raised_before): (Vec<String>, Vec<String>) = if main {
        (Vec::new(), raised().iter().cloned().collect())
    } else {
        (raised().drain().collect(), Vec::new())
    };
    let spec = Spec {
        pid: std::process::id(),
        main,
        minibar: MINIBAR_ABOVE.load(Ordering::SeqCst),
        watch_minimize: WATCH_MINIMIZE.load(Ordering::SeqCst),
        release,
        raised: raised_before,
        service: CALLBACK_SERVICE.get().cloned().unwrap_or_default(),
    };
    let result = load(&mut state, &spec);
    if result.is_err() {
        // Not cleared: the next load tries again.
        raised().extend(spec.release.iter().cloned());
    }
    result
}

fn load(state: &mut ScriptState, spec: &Spec) -> Result<(), String> {
    let name = plugin_name();
    let text = script(spec);
    if text.is_none() && !state.loaded {
        return Ok(());
    }
    let connection = Connection::new_session().map_err(|error| error.to_string())?;
    // Also replaces a script a crashed run left under the same name.
    unload(&connection, &name)?;
    state.loaded = false;
    let Some(text) = text else {
        log::info!("Linux keep on top: nothing for KWin to keep, the script is unloaded");
        return Ok(());
    };
    let path = write_script(&name, &text)?;
    let (id,): (i32,) = kwin_call(
        &connection,
        "/Scripting",
        "org.kde.kwin.Scripting",
        "loadScript",
        (path.to_string_lossy().as_ref(), name.as_str()),
    )
    .map_err(|error| format!("KWin loadScript: {error}"))?;
    if id < 0 {
        return Err(format!("KWin refused the script (id {id}); KWin scripting may be disabled"));
    }
    state.loaded = true;
    // Not `Script.run` on /Scripting/Script<id>: KWin numbers a script by
    // the count of loaded scripts, so after an unload the new id can be the
    // one the old script, still being deleted, holds that path under, and
    // `run` reaches the old object (seen on Plasma 6.7: the reloaded script
    // never ran). `start` runs every loaded script that is not running yet.
    let _: () = kwin_call(&connection, "/Scripting", "org.kde.kwin.Scripting", "start", ())
        .map_err(|error| format!("KWin Scripting.start: {error}"))?;
    log::info!(
        "Linux keep on top: KWin keeps the main window above: {}, the minibar: {}; watches the minimize: {}; releases {} window(s)",
        spec.main,
        spec.minibar,
        spec.watch_minimize,
        spec.release.len()
    );
    Ok(())
}

/// Applies a change on a thread of its own, logging a failure as `what`.
fn apply_kwin_in_background(what: &'static str, on_error: impl FnOnce(String) + Send + 'static) {
    std::thread::spawn(move || {
        if let Err(error) = apply_kwin() {
            log::warn!("Linux keep on top: {what}: {error}");
            on_error(error);
        }
    });
}

/// Unloads the script at exit, so it does not outlive the process it
/// matches by pid. A change still in flight waits for the lock and then
/// finds the script closed.
pub fn unload_kwin_script() {
    if route() != Route::KWin {
        return;
    }
    let mut state = KWIN_SCRIPT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    state.closed = true;
    if !state.loaded {
        return;
    }
    let result = Connection::new_session()
        .map_err(|error| error.to_string())
        .and_then(|connection| unload(&connection, &plugin_name()));
    match result {
        Ok(()) => state.loaded = false,
        Err(error) => log::warn!("Linux keep on top: cannot unload the KWin script ({error})"),
    }
}

/// Follows the recording: while one runs, KWin reports the main window's
/// minimize, and the app opens the minibar (lib.rs does it on X11).
pub fn recording_changed(active: bool) {
    if route() != Route::KWin || WATCH_MINIMIZE.swap(active, Ordering::SeqCst) == active {
        return;
    }
    apply_kwin_in_background("minimizing during a recording will not open the minibar", |_| {});
}

/// Whether the main window's Keep on top can work in this session. Where it
/// cannot, the title bar says so in the pin's place.
#[tauri::command]
pub fn linux_keep_on_top_available() -> bool {
    route() != Route::None
}

/// Keeps the main window above other windows, or stops. Replaces Tauri's
/// `setAlwaysOnTop` on Linux (`src/api/window.ts`). On failure the state
/// stays as it was and the error says why; the frontend sets the pin back
/// and says so.
#[tauri::command]
pub async fn linux_set_keep_on_top<R: Runtime>(app: AppHandle<R>, on_top: bool) -> Result<(), String> {
    match route() {
        Route::Window => app
            .get_webview_window("main")
            .ok_or("no main window")?
            .set_always_on_top(on_top)
            .map_err(|error| error.to_string()),
        Route::KWin => {
            let before = MAIN_ABOVE.swap(on_top, Ordering::SeqCst);
            let result = tauri::async_runtime::spawn_blocking(apply_kwin)
                .await
                .map_err(|error| error.to_string())
                .and_then(|result| result);
            if result.is_err() {
                MAIN_ABOVE.store(before, Ordering::SeqCst);
            }
            result
        }
        Route::None => Err("Keep on top isn't available in this session".into()),
    }
}

// ---------------------------------------------------------------------------
// The minibar
// ---------------------------------------------------------------------------

/// The minibar learns it cannot stay on top (Linux only): it then reads
/// [`linux_take_minibar_notice`].
pub const MINIBAR_NOTICE_EVENT: &str = "minibar-notice";

/// What the bar says in its status line, once per run.
const MINIBAR_NOTICE: &str = "Can't stay on top";

static MINIBAR_NOTICE_GIVEN: AtomicBool = AtomicBool::new(false);
static MINIBAR_NOTICE_PENDING: AtomicBool = AtomicBool::new(false);

/// Tells the bar, the first time in this run, that it cannot stay above
/// other windows. The reason goes to the log; the bar is too small for it.
fn tell_minibar_once<R: Runtime>(bar: &tauri::WebviewWindow<R>, reason: &str) {
    log::warn!("Linux minibar: it cannot stay on top ({reason})");
    if MINIBAR_NOTICE_GIVEN.swap(true, Ordering::SeqCst) {
        return;
    }
    MINIBAR_NOTICE_PENDING.store(true, Ordering::SeqCst);
    // The page may not listen yet; it also asks once it does.
    let _ = bar.emit_to(bar.label(), MINIBAR_NOTICE_EVENT, ());
}

/// The bar's notice that it cannot stay on top, once.
#[tauri::command]
pub fn linux_take_minibar_notice() -> Option<String> {
    MINIBAR_NOTICE_PENDING.swap(false, Ordering::SeqCst).then(|| MINIBAR_NOTICE.to_string())
}

/// Keeps the new minibar on top: layer-shell where the compositor has it,
/// else KWin's keep-above. X11 needs nothing (the builder's
/// `always_on_top`). Called from `minibar.rs` right after the bar is built,
/// still hidden, on any thread.
pub fn minibar_created<R: Runtime>(bar: &tauri::WebviewWindow<R>, closed_width: f64, height: f64, top: f64) {
    let (sender, receiver) = std::sync::mpsc::channel();
    let window = bar.clone();
    let queued = bar.run_on_main_thread(move || {
        let layered = match window.gtk_window() {
            Ok(gtk_window) => {
                size_minibar(&gtk_window, closed_width, height);
                report_pointer_crossings(&gtk_window, window.clone());
                is_wayland()
                    && crate::linux_desktop::layer_shell::place_minibar(
                        &gtk_window,
                        closed_width.round() as i32,
                        top.round() as i32,
                    )
            }
            Err(_) => false,
        };
        // Here, not after the wait below: a closure that runs late still
        // makes the bar a layer surface, and `resize_minibar` must know it.
        LAYERED.store(layered, Ordering::SeqCst);
        let _ = sender.send(layered);
    });
    if queued.is_err() {
        tell_minibar_once(bar, "the main thread cannot be reached");
        return;
    }
    // Waits so the role is set before the caller shows the bar. The main
    // thread does not take the minibar's lifecycle lock the caller holds.
    let layered = match receiver.recv_timeout(Duration::from_secs(2)) {
        Ok(layered) => layered,
        Err(_) => {
            log::warn!("Linux minibar: the main thread did not set the bar up within 2 s");
            false
        }
    };
    if layered {
        return;
    }
    match route() {
        Route::Window => {}
        Route::KWin => {
            MINIBAR_ABOVE.store(true, Ordering::SeqCst);
            // The bar is built before the call returns; KWin sees it when
            // it is shown, through the script's windowAdded.
            let bar = bar.clone();
            apply_kwin_in_background("KWin cannot keep the minibar on top", move |error| {
                tell_minibar_once(&bar, &error)
            });
        }
        Route::None => tell_minibar_once(
            bar,
            "this Wayland compositor has neither layer-shell nor a way to keep a window on top",
        ),
    }
}

/// The minibar was closed: KWin no longer needs to keep it above.
pub fn minibar_closed() {
    LAYERED.store(false, Ordering::SeqCst);
    if route() == Route::KWin && MINIBAR_ABOVE.swap(false, Ordering::SeqCst) {
        apply_kwin_in_background("cannot update the KWin script after the minibar closed", |_| {});
    }
}

/// Whether the minibar is a layer-shell surface (placed by margins, not by
/// window position).
static LAYERED: AtomicBool = AtomicBool::new(false);

pub fn minibar_is_layered() -> bool {
    LAYERED.load(Ordering::SeqCst)
}

/// Tells the page when the pointer leaves the bar's window and when it comes
/// back; on Linux the page takes the hover from these alone
/// (`MinibarPill`'s `pointerOver`). WebKitGTK fires no `pointerleave` (nor
/// `mouseleave` or `mouseout`) when the pointer leaves the whole view on
/// Wayland, seen in a bare WebKitGTK 4.1 window too, and the bar's window is
/// exactly the pill ([`size_minibar`]); after GTK's leave it even sends the
/// page a move at the last position inside, which would open the pill again.
/// GTK's crossings are right. Main thread only.
fn report_pointer_crossings<R: Runtime>(window: &gtk::ApplicationWindow, bar: tauri::WebviewWindow<R>) {
    use gtk::gdk::{ModifierType, NotifyType};
    let left = bar.clone();
    window.connect_leave_notify_event(move |_, event| {
        let held = event
            .state()
            .intersects(ModifierType::BUTTON1_MASK | ModifierType::BUTTON2_MASK | ModifierType::BUTTON3_MASK);
        if is_pointer_leaving(event.detail(), event.mode(), held) {
            let _ = left.emit_to(left.label(), "minibar-pointer-left", ());
        }
        glib::Propagation::Proceed
    });
    window.connect_enter_notify_event(move |_, event| {
        if event.detail() != NotifyType::Inferior {
            let _ = bar.emit_to(bar.label(), "minibar-pointer-entered", ());
        }
        glib::Propagation::Proceed
    });
}

/// Whether a leave of the bar's window is the pointer leaving it. Not one
/// into a child widget (`Inferior`), and not the compositor taking the
/// pointer for a drag of the bar: on KDE Plasma's Wayland that leave comes
/// with mode `Ungrab` and the button held, and when the move ends an enter
/// follows (seen with a virtual pointer: enter, leave Virtual/Ungrab with
/// BUTTON1, enter Normal after the move, leave Normal on the way out). On X11
/// the window manager's grab gives mode `Grab`.
fn is_pointer_leaving(detail: gtk::gdk::NotifyType, mode: gtk::gdk::CrossingMode, button_held: bool) -> bool {
    use gtk::gdk::{CrossingMode, NotifyType};
    detail != NotifyType::Inferior && mode == CrossingMode::Normal && !button_held
}

/// Sizes the bar's GTK window to the pill. GTK3 sizes a non-resizable
/// window to its size request, and the minibar's is empty (the webview asks
/// for nothing), so without one GTK falls back to 200×200 whatever
/// `inner_size` and `set_size` say: a transparent square around the pill that
/// takes the clicks meant for the windows below. Main thread only.
fn size_minibar(window: &gtk::ApplicationWindow, width: f64, height: f64) {
    let (width, height) = (width.round() as i32, height.round() as i32);
    window.set_size_request(width, height);
    window.resize(width, height);
}

/// Follows the pill's width (`resize_minibar`): the GTK window's size, and
/// on a layer-shell bar its margin.
pub fn fit_minibar<R: Runtime>(bar: &tauri::WebviewWindow<R>, closed_width: f64, width: f64, height: f64) {
    let window = bar.clone();
    let _ = bar.run_on_main_thread(move || {
        if let Ok(gtk_window) = window.gtk_window() {
            size_minibar(&gtk_window, width, height);
            if minibar_is_layered() {
                crate::linux_desktop::layer_shell::fit_minibar(
                    &gtk_window,
                    closed_width.round() as i32,
                    width.round() as i32,
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> Spec {
        Spec { pid: 42, service: ":1.7".into(), ..Spec::default() }
    }

    // The main windows' part of the script: what follows the minibar's
    // `return` in `apply`.
    fn main_part(script: &str) -> &str {
        let apply = script.find("function apply").expect("an apply function");
        let bar_return = apply + script[apply..].find("        return;\n    }\n").expect("the bar's return");
        &script[bar_return..]
    }

    #[test]
    fn nothing_pinned_loads_no_script() {
        assert_eq!(script(&spec()), None);
    }

    #[test]
    fn the_pin_raises_only_windows_not_kept_above_and_reports_them() {
        let text = script(&Spec { main: true, ..spec() }).expect("a script");
        let main = main_part(&text);
        assert!(main.contains("if (!w.keepAbove) {\n        w.keepAbove = true;\n        report(\"Raised\", w);"));
        assert!(main.contains("report(\"Released\", w)"));
        assert!(main.contains("const raised = [];"));
        assert!(!main.contains("keepAbove = false"));
        assert!(text.contains("callDBus(\":1.7\", \"/io/github/vmedvedevpro/Protocol/KWinScript\""));
        assert!(text.contains("const pid = 42;"));
        // Not unpinning: nothing to release.
        assert!(!text.contains("const release"));
    }

    #[test]
    fn a_reload_with_the_pin_on_still_follows_the_windows_it_raised() {
        let text = script(&Spec { main: true, raised: vec!["{a}".into()], ..spec() }).expect("a script");
        assert!(main_part(&text).contains("const raised = [\"{a}\"];"));
        assert!(main_part(&text).contains("} else if (raised.includes(String(w.internalId))) {\n        follow();"));
    }

    #[test]
    fn unpinning_clears_only_the_windows_the_script_raised() {
        let text = script(&Spec { release: vec!["{a}".into(), "{b}".into()], ..spec() }).expect("a script");
        assert!(text.contains("const release = [\"{a}\",\"{b}\"];"));
        assert!(text.contains("release.includes(String(w.internalId))) w.keepAbove = false;"));
        // Nothing else to do: no watcher on later windows.
        assert!(!text.contains("function apply"));
        assert!(!text.contains("keepAbove = true"));
    }

    #[test]
    fn the_minibar_alone_leaves_the_main_window_alone() {
        let text = script(&Spec { minibar: true, ..spec() }).expect("a script");
        assert!(text.contains("w.keepAbove = true;\n"));
        assert!(text.contains("if (added || !w.skipTaskbar) {"));
        assert!(!main_part(&text).contains("keepAbove"));
        assert!(!text.contains("minimizedChanged"));
    }

    #[test]
    fn a_recording_watches_the_minimize_and_touches_no_keep_above() {
        let text = script(&Spec { watch_minimize: true, ..spec() }).expect("a script");
        assert!(main_part(&text).contains("w.minimizedChanged.connect(() => { if (w.minimized) report(\"Minimized\", w); });"));
        assert!(!text.contains("keepAbove ="));
    }

    #[test]
    fn a_drag_of_the_bar_is_not_the_pointer_leaving() {
        use gtk::gdk::{CrossingMode, NotifyType};
        assert!(is_pointer_leaving(NotifyType::Nonlinear, CrossingMode::Normal, false));
        assert!(is_pointer_leaving(NotifyType::NonlinearVirtual, CrossingMode::Normal, false));
        // Into a child widget.
        assert!(!is_pointer_leaving(NotifyType::Inferior, CrossingMode::Normal, false));
        // The compositor takes the pointer for the move (Plasma's Wayland).
        assert!(!is_pointer_leaving(NotifyType::Virtual, CrossingMode::Ungrab, true));
        // The window manager's grab on X11.
        assert!(!is_pointer_leaving(NotifyType::Nonlinear, CrossingMode::Grab, false));
        // A press dragged out of the bar.
        assert!(!is_pointer_leaving(NotifyType::Nonlinear, CrossingMode::Normal, true));
    }

    #[test]
    fn the_minibar_title_is_quoted() {
        let text = script(&Spec { minibar: true, ..spec() }).expect("a script");
        assert!(text.contains("w.caption === \"Recording\""));
    }
}
