//! The tray and menu bar icon (#120): the logo's ring in one colour, like the
//! system's own icons, with a dot while a recording is on.
//! `frontend/scripts/build-icons.mjs` draws the images in `icons/tray/`; this
//! module picks one for the platform and the panel it sits on.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

use tauri::{image::Image, AppHandle, Runtime};

use super::{RecordingState, TRAY_ID};

/// On macOS every image is a template: the system tints it for the menu bar.
const TEMPLATE: bool = cfg!(target_os = "macos");

/// Whether the last state shown has a recording on, for a repaint after the
/// panel's colour changes.
static RECORDING: AtomicBool = AtomicBool::new(false);
/// The image on the tray, so a menu update that changes neither the state nor
/// the panel does not hand the same image over again (on Linux each hand-over
/// writes a file the panel reloads). 0: none yet.
static SHOWN: AtomicU8 = AtomicU8::new(0);

/// The dot means a recording is open, paused or not, until it has stopped.
pub(super) fn shows_dot(state: &RecordingState) -> bool {
    !matches!(state, RecordingState::Stopped | RecordingState::Starting)
}

/// The image the tray starts with.
pub(super) fn initial() -> (Image<'static>, bool) {
    let light = light_panel();
    SHOWN.store(key(false, light), Ordering::Relaxed);
    (image(false, light), TEMPLATE)
}

/// Shows `recording` on the tray, and says so in its tooltip.
pub(super) fn show<R: Runtime>(app: &AppHandle<R>, recording: bool) {
    RECORDING.store(recording, Ordering::Relaxed);
    let light = light_panel();
    if SHOWN.swap(key(recording, light), Ordering::Relaxed) == key(recording, light) {
        return;
    }
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    // A plain set_icon drops the template flag on macOS.
    if let Err(error) = tray.set_icon_with_as_template(Some(image(recording, light)), TEMPLATE) {
        log::warn!("Tray: could not change the icon: {error}");
    }
    let tooltip = if recording { "Protocol — Recording" } else { "Protocol" };
    if let Err(error) = tray.set_tooltip(Some(tooltip)) {
        log::warn!("Tray: could not change the tooltip: {error}");
    }
}

/// Repaints the current state, for when the panel may have changed colour.
pub(super) fn refresh<R: Runtime>(app: &AppHandle<R>) {
    show(app, RECORDING.load(Ordering::Relaxed));
}

fn key(recording: bool, light: bool) -> u8 {
    1 + u8::from(recording) + 2 * u8::from(light)
}

#[cfg(target_os = "macos")]
fn image(recording: bool, _light: bool) -> Image<'static> {
    if recording {
        tauri::include_image!("icons/tray/macos-template-recording.png")
    } else {
        tauri::include_image!("icons/tray/macos-template.png")
    }
}

#[cfg(windows)]
fn image(recording: bool, light: bool) -> Image<'static> {
    match (light, recording) {
        (false, false) => tauri::include_image!("icons/tray/windows-white.png"),
        (false, true) => tauri::include_image!("icons/tray/windows-white-recording.png"),
        (true, false) => tauri::include_image!("icons/tray/windows-black.png"),
        (true, true) => tauri::include_image!("icons/tray/windows-black-recording.png"),
    }
}

#[cfg(target_os = "linux")]
fn image(recording: bool, light: bool) -> Image<'static> {
    match (light, recording) {
        (false, false) => tauri::include_image!("icons/tray/linux-white.png"),
        (false, true) => tauri::include_image!("icons/tray/linux-white-recording.png"),
        (true, false) => tauri::include_image!("icons/tray/linux-black.png"),
        (true, true) => tauri::include_image!("icons/tray/linux-black-recording.png"),
    }
}

/// The template needs no colour.
#[cfg(target_os = "macos")]
fn light_panel() -> bool {
    false
}

/// The taskbar follows "Windows mode", which can differ from the apps' mode the
/// window reports, so it is read from the registry.
#[cfg(windows)]
fn light_panel() -> bool {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|key| key.get_value::<u32, _>("SystemUsesLightTheme"))
        // Without the value (Windows 10 before 1903) the taskbar is dark.
        .is_ok_and(|light| light != 0)
}

/// GNOME's top bar and most other panels are dark whatever the theme. Plasma's
/// panel takes the colour scheme's window colour; the window's own theme
/// cannot tell it (the app may force one, and GTK reports Breeze Dark as
/// light), so `kdeglobals` is read.
#[cfg(target_os = "linux")]
fn light_panel() -> bool {
    let plasma = std::env::var("XDG_CURRENT_DESKTOP")
        .is_ok_and(|desktops| desktops.split(':').any(|name| name.eq_ignore_ascii_case("KDE")));
    // A scheme never changed from the default is Breeze Light.
    plasma && plasma_window_is_light().unwrap_or(true)
}

#[cfg(target_os = "linux")]
fn plasma_window_is_light() -> Option<bool> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| std::path::Path::new(&home).join(".config")))?;
    window_is_light(&std::fs::read_to_string(config.join("kdeglobals")).ok()?)
}

/// Whether `kdeglobals` gives the window a light background (`r,g,b` in
/// `[Colors:Window]`), or `None` when it says nothing about it.
#[cfg(any(target_os = "linux", test))]
fn window_is_light(kdeglobals: &str) -> Option<bool> {
    let mut in_window = false;
    for line in kdeglobals.lines().map(str::trim) {
        if line.starts_with('[') {
            in_window = line == "[Colors:Window]";
        } else if let Some(value) = line.strip_prefix("BackgroundNormal=").filter(|_| in_window) {
            let rgb: Vec<f32> = value.split(',').filter_map(|part| part.trim().parse().ok()).collect();
            if let [r, g, b, ..] = rgb[..] {
                return Some(0.299 * r + 0.587 * g + 0.114 * b > 127.5);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dot_shows_from_recording_until_stopped() {
        assert!(!shows_dot(&RecordingState::Stopped));
        assert!(!shows_dot(&RecordingState::Starting));
        for state in [
            RecordingState::Recording,
            RecordingState::Pausing,
            RecordingState::Paused,
            RecordingState::Resuming,
            RecordingState::Stopping,
        ] {
            assert!(shows_dot(&state), "{state:?}");
        }
    }

    #[test]
    fn plasma_panel_colour_comes_from_the_window_background() {
        let breeze_dark = "[Colors:Button]\nBackgroundNormal=252,252,252\n\n[Colors:Window]\nBackgroundAlternate=49,54,59\nBackgroundNormal=32,35,38\n";
        assert_eq!(window_is_light(breeze_dark), Some(false));
        let breeze_light = "[Colors:Window]\nBackgroundNormal=239,240,241\n";
        assert_eq!(window_is_light(breeze_light), Some(true));
        // Another section's background, or none at all, says nothing.
        assert_eq!(window_is_light("[Colors:View]\nBackgroundNormal=20,20,20\n"), None);
        assert_eq!(window_is_light(""), None);
    }
}
