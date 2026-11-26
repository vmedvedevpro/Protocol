//! The name a desktop matches the app's windows to its desktop file by (#191).
//!
//! GTK names every window after GLib's program name: Wayland's `app_id`
//! (`xdg_toplevel.set_app_id`), and X11's `WM_CLASS`, whose instance is the
//! program name and whose class is the same with its first letter upper-cased.
//! Unset, the program name is the executable's, `protocol`. KWin finds a
//! Wayland window's desktop file, and with it the icon, only by file name
//! (`<app_id>.desktop`), and tauri-bundler names the desktop file after the
//! product (`Protocol.desktop`), so the window showed Wayland's generic icon.
//!
//! The program name is therefore the product name, and the desktop file's
//! `StartupWMClass` repeats it (`linux/main.desktop`), so the four agree. The
//! Linux release leg checks the packaged desktop file against the product
//! name and the line [`set`] logs (scripts/release/check-linux-desktop-entry.mjs).

/// Names the app for GTK. Runs before GTK starts (tao initializes it when
/// Tauri builds the app): GDK reads the program class once, at its start.
pub fn set(product_name: &str) {
    glib::set_prgname(Some(product_name));
    log::info!("Linux app id: {product_name}");
}
