//! Keep on top for the main window and the minibar on Linux (#199).
//!
//! Tauri's `set_always_on_top` ends in GTK3's `gtk_window_set_keep_above`,
//! which works on X11 (an EWMH state the window manager honours) and does
//! nothing on Wayland, where no protocol lets a client keep its window above
//! others. So the route depends on the session, found once at start
//! ([`init`]):
//! - X11 (any desktop, XWayland included): Tauri's call, as before.
//! - Wayland under KWin (KDE Plasma): KWin runs scripts sent over D-Bus
//!   (`org.kde.KWin /Scripting`), and a script may set `keepAbove` on a
//!   window. [`apply_kwin`] loads one that sets it on this process's windows.
//! - Other Wayland compositors (GNOME, wlroots): none. The main window's
//!   button is hidden ([`linux_keep_on_top_available`]); GNOME offers Always
//!   on Top in the native frame's window menu instead. The minibar uses
//!   layer-shell where the compositor has it (`layer_shell.rs`), else it is a
//!   plain window and the log says it cannot stay on top.
//!
//! KWin forgets a Wayland window when it is unmapped, and the main window is
//! hidden while the minibar shows, so the script stays loaded and also sets
//! the state on windows added later. It is reloaded with the new state on
//! each change and unloaded at exit ([`unload_kwin_script`]).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use dbus::blocking::Connection;
use gtk::prelude::*;
use tauri::{AppHandle, Manager, Runtime};

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

/// Finds the route. Runs in Tauri's setup, on the main thread, before any
/// window asks.
pub fn init() {
    let route = if !is_wayland() {
        Route::Window
    } else if kwin_on_bus() {
        Route::KWin
    } else {
        Route::None
    };
    log::info!("Linux keep on top: {route:?}");
    let _ = ROUTE.set(route);
}

// The state the KWin script applies. The minibar's is set while it exists
// and has no layer-shell surface.
static MAIN_ABOVE: AtomicBool = AtomicBool::new(false);
static MINIBAR_ABOVE: AtomicBool = AtomicBool::new(false);
// Serializes script reloads, so two changes cannot interleave their
// unload and load.
static KWIN_SCRIPT: Mutex<()> = Mutex::new(());

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

fn script(pid: u32, main: bool, minibar: bool) -> String {
    let title = serde_json::to_string(MINIBAR_TITLE).expect("a string serializes");
    // Plasma 6 names it windowList/windowAdded, Plasma 5 clientList/clientAdded.
    format!(
        r#"// Written by Protocol (src/linux_desktop/keep_above.rs).
const pid = {pid};
const main = {main};
const minibar = {minibar};
function apply(w, added) {{
    if (w.pid !== pid || !w.normalWindow) return;
    if (w.caption === {title}) {{
        w.keepAbove = minibar;
        if (minibar && added) {{
            // Wayland lets no client place its window; put the bar top centre.
            w.skipTaskbar = true;
            w.skipSwitcher = true;
            const area = workspace.clientArea(KWin.PlacementArea, w);
            const g = w.frameGeometry;
            w.frameGeometry = {{x: area.x + Math.round((area.width - g.width) / 2), y: area.y + 12,
                width: g.width, height: g.height}};
        }}
    }} else {{
        w.keepAbove = main;
    }}
}}
const windows = workspace.windowList ? workspace.windowList() : workspace.clientList();
for (const w of windows) apply(w, false);
(workspace.windowAdded || workspace.clientAdded).connect(w => apply(w, true));
"#
    )
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

/// Loads the script with the current state, replacing the one before.
/// Blocks on D-Bus; call it off the main thread.
fn apply_kwin() -> Result<(), String> {
    let _serial = KWIN_SCRIPT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let main = MAIN_ABOVE.load(Ordering::SeqCst);
    let minibar = MINIBAR_ABOVE.load(Ordering::SeqCst);
    let name = plugin_name();
    // KWin reads the file when the script runs; it lives in the runtime dir,
    // private to the user.
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let path = dir.join(format!("{name}.js"));
    std::fs::write(&path, script(std::process::id(), main, minibar))
        .map_err(|error| format!("cannot write the KWin script {}: {error}", path.display()))?;

    let connection = Connection::new_session().map_err(|error| error.to_string())?;
    let scripting = "org.kde.kwin.Scripting";
    let _: (bool,) = kwin_call(&connection, "/Scripting", scripting, "unloadScript", (name.as_str(),))
        .map_err(|error| format!("KWin unloadScript: {error}"))?;
    let (id,): (i32,) = kwin_call(
        &connection,
        "/Scripting",
        scripting,
        "loadScript",
        (path.to_string_lossy().as_ref(), name.as_str()),
    )
    .map_err(|error| format!("KWin loadScript: {error}"))?;
    if id < 0 {
        return Err(format!("KWin refused the script {} (id {id})", path.display()));
    }
    // Plasma 6 serves scripts under /Scripting/Script<id>, Plasma 5 under /<id>.
    let run = |path: &str| -> Result<(), dbus::Error> {
        kwin_call(&connection, path, "org.kde.kwin.Script", "run", ())
    };
    run(&format!("/Scripting/Script{id}"))
        .or_else(|_| run(&format!("/{id}")))
        .map_err(|error| format!("KWin Script.run: {error}"))?;
    log::info!("Linux keep on top: KWin keeps the main window above: {main}, the minibar: {minibar}");
    Ok(())
}

/// Unloads the script at exit, so it does not outlive the process it
/// matches by pid.
pub fn unload_kwin_script() {
    if route() != Route::KWin {
        return;
    }
    let unload = || -> Result<(), dbus::Error> {
        let connection = Connection::new_session()?;
        let _: (bool,) = kwin_call(
            &connection,
            "/Scripting",
            "org.kde.kwin.Scripting",
            "unloadScript",
            (plugin_name().as_str(),),
        )?;
        Ok(())
    };
    if let Err(error) = unload() {
        log::warn!("Linux keep on top: cannot unload the KWin script ({error})");
    }
}

/// Whether the main window's Keep on top can work in this session. The
/// frontend hides the button where it cannot.
#[tauri::command]
pub fn linux_keep_on_top_available() -> bool {
    route() != Route::None
}

/// Keeps the main window above other windows, or stops. Replaces Tauri's
/// `setAlwaysOnTop` on Linux (`src/api/window.ts`).
#[tauri::command]
pub async fn linux_set_keep_on_top<R: Runtime>(app: AppHandle<R>, on_top: bool) -> Result<(), String> {
    match route() {
        Route::Window => app
            .get_webview_window("main")
            .ok_or("no main window")?
            .set_always_on_top(on_top)
            .map_err(|error| error.to_string()),
        Route::KWin => {
            MAIN_ABOVE.store(on_top, Ordering::SeqCst);
            tauri::async_runtime::spawn_blocking(apply_kwin)
                .await
                .map_err(|error| error.to_string())?
        }
        Route::None => Err("Keep on top is not available in this Wayland session".into()),
    }
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
                report_pointer_leaving(&gtk_window, window.clone());
                is_wayland()
                    && crate::linux_desktop::layer_shell::place_minibar(
                        &gtk_window,
                        closed_width.round() as i32,
                        top.round() as i32,
                    )
            }
            Err(_) => false,
        };
        let _ = sender.send(layered);
    });
    if queued.is_err() {
        log::warn!("Linux minibar: cannot reach the main thread");
        return;
    }
    // Waits so the role is set before the caller shows the bar. The main
    // thread does not take the minibar's lifecycle lock the caller holds.
    let layered = receiver.recv_timeout(Duration::from_secs(2)).unwrap_or(false);
    LAYERED.store(layered, Ordering::SeqCst);
    if layered {
        return;
    }
    match route() {
        Route::Window => {}
        Route::KWin => {
            MINIBAR_ABOVE.store(true, Ordering::SeqCst);
            // The bar is built before the call returns; KWin sees it when
            // it is shown, through the script's windowAdded.
            std::thread::spawn(|| {
                if let Err(error) = apply_kwin() {
                    log::warn!("Linux minibar: KWin cannot keep it on top ({error})");
                }
            });
        }
        Route::None => log::warn!(
            "Linux minibar: this Wayland compositor has neither layer-shell nor a way to keep a window on top; the bar is a plain window"
        ),
    }
}

/// Whether the minibar is a layer-shell surface (placed by margins, not by
/// window position).
static LAYERED: AtomicBool = AtomicBool::new(false);

pub fn minibar_is_layered() -> bool {
    LAYERED.load(Ordering::SeqCst)
}

/// Tells the page when the pointer leaves the bar's window. WebKitGTK fires
/// no `pointerleave` (nor `mouseleave` or `mouseout`) when the pointer leaves
/// the whole view on Wayland, seen in a bare WebKitGTK 4.1 window too, and
/// the bar's window is exactly the pill ([`size_minibar`]), so the open pill
/// would stay open. GTK still gets the crossing; a leave into a child widget
/// (`Inferior`) is not one. Main thread only.
fn report_pointer_leaving<R: Runtime>(window: &gtk::ApplicationWindow, bar: tauri::WebviewWindow<R>) {
    use tauri::Emitter;
    window.connect_leave_notify_event(move |_, event| {
        if event.detail() != gtk::gdk::NotifyType::Inferior {
            let _ = bar.emit_to(bar.label(), "minibar-pointer-left", ());
        }
        glib::Propagation::Proceed
    });
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
