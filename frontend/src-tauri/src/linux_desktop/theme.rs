//! The windows' colour scheme on Linux (#198).
//!
//! WebKitGTK reports `prefers-color-scheme: dark` while GTK's
//! `gtk-application-prefer-dark-theme` setting is on, and on GNOME's title
//! bar GTK draws the dark variant then too. The setting is one for the whole
//! process, so it is the theme of both windows. tao 0.37.2 writes it three
//! times:
//! - when it creates a window, from the settings portal's
//!   `org.freedesktop.appearance color-scheme` (prefer dark: on; prefer light
//!   or no preference: off), if the portal answers;
//! - on the portal's `SettingChanged` for that key, the same way (tao's `dbus`
//!   feature, on through Tauri's defaults);
//! - on `Window::set_theme(theme)`, as `theme == Some(Dark)`.
//!
//! The last makes `set_theme(None)`, "hand the theme back to the system",
//! force light, which is what Match system did through Tauri's `setTheme(null)`.
//! So on Linux the frontend hands its mode to [`set_window_theme`] instead:
//! - Match system: the portal's colour scheme now, and from then on tao's
//!   listener follows its changes. Where no portal answers, GTK's own value
//!   (its settings.ini or XSETTINGS) is restored.
//! - Light or Dark: that value, held by [`init`]'s guard, because tao's
//!   listener would otherwise follow the desktop again at its next change.

use std::sync::Mutex;
use std::time::Duration;

use gtk::prelude::GtkSettingsExt;
use tauri::{AppHandle, Runtime};

const PREFER_DARK: &str = "gtk-application-prefer-dark-theme";

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    System,
    Light,
    Dark,
}

impl Mode {
    /// The value Light or Dark holds the setting at; none for Match system.
    fn forced_dark(self) -> Option<bool> {
        match self {
            Mode::System => None,
            Mode::Light => Some(false),
            Mode::Dark => Some(true),
        }
    }
}

/// The frontend's last choice. Read on the GTK main thread by the guard.
static MODE: Mutex<Mode> = Mutex::new(Mode::System);

fn mode() -> Mode {
    *MODE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Holds a forced theme against tao's portal listener: whenever the setting
/// changes to something else while Light or Dark is chosen, it is set back.
/// Runs on the main thread (Tauri's setup), where GTK lives.
pub fn init() {
    let Some(settings) = gtk::Settings::default() else {
        log::warn!("Linux theme: no GTK settings, the theme cannot follow the choice");
        return;
    };
    settings.connect_gtk_application_prefer_dark_theme_notify(|settings| {
        if let Some(dark) = mode().forced_dark() {
            if settings.is_gtk_application_prefer_dark_theme() != dark {
                settings.set_gtk_application_prefer_dark_theme(dark);
            }
        }
    });
}

/// The colour scheme the settings portal reports: `Some(true)` for prefer
/// dark, `Some(false)` for prefer light or no preference (as tao reads it, and
/// as GNOME means its "Default"), `None` when no portal answers.
fn portal_prefers_dark() -> Option<bool> {
    use dbus::arg::Variant;
    use dbus::blocking::Connection;

    let read = || -> Result<u32, dbus::Error> {
        let connection = Connection::new_session()?;
        let proxy = connection.with_proxy(
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            Duration::from_secs(2),
        );
        // Read wraps the value in a second variant (ReadOne would not, but
        // portals before 1.15 lack it).
        let (value,): (Variant<Variant<u32>>,) = proxy.method_call(
            "org.freedesktop.portal.Settings",
            "Read",
            ("org.freedesktop.appearance", "color-scheme"),
        )?;
        Ok(value.0 .0)
    };
    match read() {
        Ok(scheme) => Some(scheme == 1),
        Err(error) => {
            log::info!("Linux theme: the settings portal gave no colour scheme ({error}); using GTK's own setting");
            None
        }
    }
}

/// Applies the frontend's theme mode: `None` for Match system, else
/// `"light"` or `"dark"`. Replaces Tauri's `setTheme` on Linux
/// (`src/api/window.ts`).
#[tauri::command]
pub async fn linux_set_window_theme<R: Runtime>(
    app: AppHandle<R>,
    theme: Option<String>,
) -> Result<(), String> {
    let chosen = match theme.as_deref() {
        None => Mode::System,
        Some("light") => Mode::Light,
        Some("dark") => Mode::Dark,
        Some(other) => return Err(format!("Unknown theme {other:?}")),
    };
    *MODE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = chosen;
    // The portal call blocks for up to its timeout; this runs on Tauri's
    // async pool, not on the main thread.
    let dark = match chosen.forced_dark() {
        Some(dark) => Some(dark),
        None => portal_prefers_dark(),
    };
    app.run_on_main_thread(move || {
        let Some(settings) = gtk::Settings::default() else {
            return;
        };
        // A later call may have changed the mode while the portal answered.
        if mode() != chosen {
            return;
        }
        match dark {
            Some(dark) => settings.set_gtk_application_prefer_dark_theme(dark),
            // What settings.ini or XSETTINGS say, as before anything set it.
            None => settings.reset_property(PREFER_DARK),
        }
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::Mode;

    #[test]
    fn only_light_and_dark_force_the_setting() {
        assert_eq!(Mode::System.forced_dark(), None);
        assert_eq!(Mode::Light.forced_dark(), Some(false));
        assert_eq!(Mode::Dark.forced_dark(), Some(true));
    }
}
