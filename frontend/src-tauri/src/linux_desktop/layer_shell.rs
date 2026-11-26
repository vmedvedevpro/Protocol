//! The minibar as a layer-shell overlay on Wayland (#199).
//!
//! A Wayland client cannot keep its own window above others or place it:
//! GTK3 drops `gtk_window_set_keep_above` and `gtk_window_move` there. The
//! layer-shell protocol (`zwlr_layer_shell_v1`, on KDE Plasma and wlroots
//! compositors, not on GNOME) gives a surface a layer instead of a window
//! role: on the overlay layer it stays above normal windows, anchored where
//! the client asks. The minibar is an overlay, so it fits.
//!
//! gtk-layer-shell (GTK3) is loaded at run time, like the Vulkan loader, so
//! the deb and the AppImage still start where it is missing; the deb only
//! recommends `libgtk-layer-shell0`. Its 0.10 release is a plain client
//! library (it imports libwayland's symbols and exports none), so a late
//! `dlopen` works; gtk4-layer-shell, which shims libwayland and must be linked
//! before it, would not.
//!
//! The surface must get its layer role before GTK realizes the window, so
//! [`place_minibar`] runs right after the minibar is built hidden, on the main
//! thread. A layer surface cannot be dragged (no `xdg_toplevel.move`), so the
//! bar stays where it is anchored: top centre, 12 px down, its left edge fixed
//! while the pill opens rightwards ([`fit_minibar`]).

use std::ffi::{c_char, c_int, c_void, CString};
use std::sync::OnceLock;

use gtk::prelude::*;

type Window = *mut gtk::ffi::GtkWindow;

// From gtk-layer-shell.h (stable since 0.1; is_supported and the keyboard
// mode since 0.6).
const LAYER_OVERLAY: c_int = 3;
const EDGE_LEFT: c_int = 0;
const EDGE_TOP: c_int = 2;
const KEYBOARD_MODE_ON_DEMAND: c_int = 2;

struct Api {
    // Keeps the library loaded for the function pointers below.
    _library: libloading::Library,
    is_supported: unsafe extern "C" fn() -> c_int,
    init_for_window: unsafe extern "C" fn(Window),
    set_namespace: unsafe extern "C" fn(Window, *const c_char),
    set_layer: unsafe extern "C" fn(Window, c_int),
    set_anchor: unsafe extern "C" fn(Window, c_int, c_int),
    set_margin: unsafe extern "C" fn(Window, c_int, c_int),
    set_monitor: unsafe extern "C" fn(Window, *mut c_void),
    set_keyboard_mode: unsafe extern "C" fn(Window, c_int),
}

const LIBRARY: &str = "libgtk-layer-shell.so.0";

fn load() -> Result<Api, String> {
    // SAFETY: loading a C library with no initializers of note; every symbol
    // below is read with the signature gtk-layer-shell.h declares.
    unsafe {
        let library = libloading::Library::new(LIBRARY).map_err(|error| error.to_string())?;
        macro_rules! symbol {
            ($name:literal) => {
                *library
                    .get(concat!($name, "\0").as_bytes())
                    .map_err(|error| format!("{}: {error}", $name))?
            };
        }
        Ok(Api {
            is_supported: symbol!("gtk_layer_is_supported"),
            init_for_window: symbol!("gtk_layer_init_for_window"),
            set_namespace: symbol!("gtk_layer_set_namespace"),
            set_layer: symbol!("gtk_layer_set_layer"),
            set_anchor: symbol!("gtk_layer_set_anchor"),
            set_margin: symbol!("gtk_layer_set_margin"),
            set_monitor: symbol!("gtk_layer_set_monitor"),
            set_keyboard_mode: symbol!("gtk_layer_set_keyboard_mode"),
            _library: library,
        })
    }
}

/// The library, once it loaded and the compositor offers the protocol.
/// Main thread only (it asks GDK's Wayland display).
fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| match load() {
        // SAFETY: GTK is initialised; called on the main thread.
        Ok(api) if unsafe { (api.is_supported)() } != 0 => {
            log::info!("Linux minibar: layer-shell available through {LIBRARY}");
            Some(api)
        }
        Ok(_) => {
            log::info!("Linux minibar: the compositor has no layer-shell protocol");
            None
        }
        Err(error) => {
            log::info!("Linux minibar: {LIBRARY} not loaded ({error})");
            None
        }
    })
    .as_ref()
}

/// The monitor the bar goes on and its logical width: GDK's primary
/// monitor, else the first.
fn monitor() -> Option<(gtk::gdk::Monitor, i32)> {
    let display = gtk::gdk::Display::default()?;
    let monitor = display.primary_monitor().or_else(|| display.monitor(0))?;
    let width = monitor.geometry().width();
    Some((monitor, width))
}

/// The left margin that centres a bar `closed` px wide on a monitor `screen`
/// px wide, and keeps a bar `width` px wide on the monitor.
pub(crate) fn left_margin(screen: i32, closed: i32, width: i32) -> i32 {
    let home = (screen - closed) / 2;
    home.min(screen - width).max(0)
}

/// Makes the hidden, unmapped minibar an overlay surface, top centre, `top`
/// px down, sized `closed` px wide. Returns false where layer-shell is not
/// available; the caller then keeps it on top another way or says it cannot.
/// Main thread only.
pub fn place_minibar(window: &gtk::ApplicationWindow, closed: i32, top: i32) -> bool {
    let Some(api) = api() else {
        return false;
    };
    if window.is_realized() {
        // Not expected (the bar is built hidden), but the role can only be
        // given to an unrealized window, and a hidden one can drop its GDK
        // window safely.
        log::info!("Linux minibar: unrealizing the hidden bar before giving it the layer role");
        window.unrealize();
    }
    let raw: Window = window.upcast_ref::<gtk::Window>().as_ptr();
    let namespace = CString::new("protocol-minibar").expect("no NUL");
    // SAFETY: `raw` is a live GtkWindow, unrealized; main thread.
    unsafe {
        (api.init_for_window)(raw);
        (api.set_namespace)(raw, namespace.as_ptr());
        (api.set_layer)(raw, LAYER_OVERLAY);
        (api.set_keyboard_mode)(raw, KEYBOARD_MODE_ON_DEMAND);
        (api.set_anchor)(raw, EDGE_TOP, 1);
        (api.set_anchor)(raw, EDGE_LEFT, 1);
        (api.set_margin)(raw, EDGE_TOP, top);
        let mut left = 0;
        if let Some((monitor, screen)) = monitor() {
            (api.set_monitor)(raw, monitor.as_ptr() as *mut c_void);
            left = left_margin(screen, closed, closed);
        }
        (api.set_margin)(raw, EDGE_LEFT, left);
    }
    log::info!("Linux minibar: placed on the overlay layer");
    true
}

/// Keeps the bar's left edge as the pill opens to `width` px, moving it left
/// only where it would leave the monitor. Main thread only.
pub fn fit_minibar(window: &gtk::ApplicationWindow, closed: i32, width: i32) {
    let Some(api) = api() else {
        return;
    };
    let Some((_, screen)) = monitor() else {
        return;
    };
    let raw: Window = window.upcast_ref::<gtk::Window>().as_ptr();
    // SAFETY: `raw` is a live GtkWindow that place_minibar made a layer
    // surface; main thread.
    unsafe { (api.set_margin)(raw, EDGE_LEFT, left_margin(screen, closed, width)) };
}

#[cfg(test)]
mod tests {
    use super::left_margin;

    #[test]
    fn the_bar_stays_centred_until_it_would_leave_the_monitor() {
        // A 1000 px monitor, a 170 px closed bar: centred at 415.
        assert_eq!(left_margin(1000, 170, 170), 415);
        // Open, 512 wide, it still fits from 415 (415 + 512 < 1000).
        assert_eq!(left_margin(1000, 170, 512), 415);
        // On a 800 px monitor the open bar moves left to stay on it.
        assert_eq!(left_margin(800, 170, 512), 288);
        // Never past the left edge.
        assert_eq!(left_margin(400, 170, 512), 0);
    }
}
