# The Linux desktop: frame, app id, dark mode, keep on top, tray name

How the main window, the minibar and the tray fit a Linux desktop (#215, which
merged #200, #191, #198, #199 and the tray name). Each part says what the code
does, why, which files own it, how it was checked and what is left.

## Native window frame (#200)

On Linux the main window uses the desktop's own frame:
`tauri.linux.conf.json` repeats the whole window entry with
`"decorations": true` (a platform file replaces the `windows` array, as
`tauri.macos.conf.json` does). Windows stays frameless (`tauri.conf.json`)
and macOS keeps its overlay title bar.

GTK3 asks KWin for server-side decorations through the KDE server-decoration
protocol, so on KDE Plasma the window gets KWin's title bar (the user's
decoration theme, its buttons in the user's order, rounded corners, shadow and
edge) and KWin's moving, resizing, maximizing, tiling and window menu. On
GNOME, which has no server-side decorations, GTK draws its own title bar
(client-side decorations) with the same duties.

The app's strip (`frontend/src/app/shell/TitleBar.tsx`) then draws no chrome
on Linux: no close button, no title and no drag region, only the app's row
of Back and Keep on top, 40 px (`sizes.titleBar.linux`) under the native title
bar. The window's title follows the screen instead (`useWindowTitle` in
`Shell.tsx`: "Settings — Protocol", "Welcome — Protocol", "Protocol" on the
meetings), so the native title bar, the task manager and the window switcher
name it.

The minimum size (`minWidth` 360, `minHeight` 480) is the content's: tao sets
GTK's geometry hints on the window, and the server-side title bar is added
outside them. The minibar keeps its own frameless chrome (`minibar.rs`).

Checked on KDE Plasma 6.7.5, Wayland, scale 1.75 (the owner's session, an
isolated "Protocol QA" build): KWin decorates the window (title "Welcome —
Protocol" on first launch), and asking KWin for a 200×300 frame left a 360×480
content area under the 30 px title bar.

Not checked here: GNOME, and X11 sessions (no GNOME or X11 session on this
machine). GTK's client-side title bar on GNOME is GTK's default window, not
code of ours.

## The window's app id and icon (#191)

A desktop shows a window's icon from the window's desktop file, and finds
that file by the window's name. KWin takes the Wayland `app_id` as the file
name (`<app_id>.desktop`) and nothing else; GNOME Shell does the same and,
like Plasma's task manager on X11, also matches `WM_CLASS` to
`StartupWMClass`. GTK names every window after GLib's program name: the
`app_id`, and `WM_CLASS` (instance: the program name; class: the same with an
upper-case first letter). Unset, the program name is the executable's,
`protocol`, while tauri-bundler names the desktop file after the product,
`Protocol.desktop`. So KWin found no desktop file and showed Wayland's
generic "W" icon: a build of 1.0.0-rc.1's code showed
`desktopFileName: "protocol"` in KWin and the "W" in its title bar. (`app.enableGtkAppId` would take the identifier instead, which no
desktop file of ours is named after, and make the app a unique GtkApplication
beside the single-instance plugin, so it is left off.)

The fix makes all four names the product name:

- `linux_desktop::app_id::set` (`src-tauri/src/linux_desktop/app_id.rs`)
  sets the program name to the product name in `run()`, before Tauri starts
  GTK, and logs `Linux app id: <name>`.
- `src-tauri/linux/main.desktop`, tauri-bundler's own template with
  `StartupWMClass={{name}}` in place of `{{exec}}`, is the desktop template
  (`bundle.linux.deb.desktopTemplate` in `tauri.linux.conf.json`). The
  AppImage is built from the deb's data (`debian::generate_data` in
  tauri-bundler), so it gets the same file.

The Linux release leg checks the agreement
(`scripts/release/check-linux-desktop-entry.mjs`, tests in
`scripts/release/test/check-linux-desktop-entry.test.mjs`): the deb and the
AppImage hold one desktop file, `<productName>.desktop`, whose
`StartupWMClass` is the product name and whose icon is in `hicolor`, and the
AppImage's start under xvfb logs `Linux app id: <productName>`. On an
AppImage built here from 1.0.0-rc.1's code it fails with `StartupWMClass is
"protocol"`.

Checked on KDE Plasma 6.7.5, Wayland: a "Protocol QA" build with a "Protocol
QA.desktop" as the deb would install it got `desktopFileName: "Protocol QA"`,
`resourceClass: "Protocol QA"` from KWin, the ring in its title bar and in the
task manager.

Not checked: GNOME, X11 sessions, and an AppImage integrated by
AppImageLauncher or Gear Lever. Those tools install the desktop file under a
name of their own (`appimagekit_<hash>-Protocol.desktop`), which KWin cannot
match by `app_id`; Plasma's task manager and GNOME Shell should still match
it by `StartupWMClass`, which was not tried.

## Dark mode from the desktop (#198)

WebKitGTK reports `prefers-color-scheme: dark` while GTK's
`gtk-application-prefer-dark-theme` setting is on; the setting is one for the
process, so both windows share it. tao 0.37.2 writes it when it creates a
window (from the settings portal's `org.freedesktop.appearance
color-scheme`), on the portal's `SettingChanged` for that key, and on
`Window::set_theme(theme)` as `theme == Some(Dark)`. The last made Match
system, which called Tauri's `setTheme(null)` to "hand the theme back to the
system", force light.

So on Linux the frontend's `setWindowTheme` (`src/api/window.ts`) calls the
native `linux_set_window_theme` (`src-tauri/src/linux_desktop/theme.rs`)
instead of Tauri's `setTheme`:

- Match system sets the setting from the portal's colour scheme now (prefer
  dark: on; prefer light or no preference: off), and tao's portal listener
  follows its changes from then on. Where no portal answers, GTK's own value
  (settings.ini or XSETTINGS) is restored with `reset_property`.
- Light and Dark set the value and hold it: a notify handler installed in
  setup (`theme::init`) sets it back whenever tao's listener changes it
  while a forced mode is chosen.

Windows and macOS keep Tauri's `setTheme`.

Checked on KDE Plasma 6.7.5, Wayland (the "Protocol QA" build, Match system):
with the owner's dark scheme (portal `color-scheme` 1) the app started dark;
switching the desktop to Breeze Light (portal 2) repainted it light while it
ran, and switching back repainted it dark. The unit test covers which modes
force the setting; `App.test.tsx` that Linux hands every mode to the native
command and never calls Tauri's `setTheme`.

Not checked: GNOME (its portal answers the same key, but no GNOME session
here), a desktop without the portal (GTK's own value), and Light or Dark held
against a live desktop switch in the app.
