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

## Keep on top and the minibar under Wayland (#199)

Tauri's `set_always_on_top` ends in GTK3's `gtk_window_set_keep_above`. On
X11 that is an EWMH state the window manager honours; on Wayland no protocol
lets a client keep its window above others or place it, and GTK drops the
call (and `gtk_window_move`). `linux_desktop/keep_above.rs` picks a route once
at start (`keep_above::init`, logged as `Linux keep on top: …`):

| Session | Keep on top (main window) | Minibar |
|---|---|---|
| X11, any desktop | Tauri's call, as before | the builder's `always_on_top` and position, as before |
| Wayland, KDE Plasma (KWin on the session bus) | a KWin script | layer-shell overlay if gtk-layer-shell loads, else the KWin script |
| Wayland, wlroots (Sway, Hyprland…) | not offered | layer-shell overlay if gtk-layer-shell loads |
| Wayland, GNOME | not offered; the native frame's window menu has Always on Top | a plain window: the log says it cannot stay on top |

XWayland for the whole app (`GDK_BACKEND=x11`) would make keep-above work
everywhere but blurs the window on fractional scaling, so it is not used.

**The KWin script.** KWin runs scripts sent over D-Bus
(`org.kde.KWin /Scripting` `loadScript`, then `Script.run`), and a script may
set `keepAbove` on any window. The script is written to `$XDG_RUNTIME_DIR`
and matches this process's windows by pid: the minibar by its title
(`Recording`, since Wayland has no skip-taskbar hint for KWin to read), the
main window as every other normal window. KWin forgets a Wayland window when
it is unmapped, and the main window is hidden while the minibar shows, so the
script stays loaded and also applies to windows added later; it is reloaded
with the new state on each change under one plugin name per program name
(`<app>-keep-above`, so a new start replaces what a crashed run left) and
unloaded at `RunEvent::Exit`. For the minibar it also hides it from the task
manager and the switcher and puts it top centre, 12 px down; it can still be
dragged.

The frontend asks `linux_keep_on_top_available` once and shows the pin only
where a route exists (`useKeepOnTopAvailable`, `TitleBar`'s optional
`onTopChange`); `setWindowAlwaysOnTop` calls `linux_set_keep_on_top` on Linux.

**The layer-shell minibar.** The layer-shell protocol (`zwlr_layer_shell_v1`,
on KDE Plasma and wlroots compositors, not on GNOME) gives a surface a layer
instead of a window role. `linux_desktop/layer_shell.rs` loads
`libgtk-layer-shell.so.0` with `dlopen`, as the Vulkan loader is, so the deb
and the AppImage start where it is missing: the deb recommends
`libgtk-layer-shell0` (Recommends, not Depends, since the app runs without
it), and the AppImage takes the system's. gtk-layer-shell 0.10 imports
libwayland's symbols and exports none, so loading it late works
(gtk4-layer-shell shims libwayland and must be linked first). Right after
`minibar.rs` builds the bar, hidden and unrealized, `keep_above::minibar_created`
gives it the role on the main thread: the overlay layer, anchored top and
left on GDK's primary monitor, 12 px down and centred by its left margin,
keyboard on demand, namespace `protocol-minibar`. A layer surface cannot be
dragged, so the bar stays there; as the pill opens rightwards its left margin
stays, moving left only where it would leave the monitor
(`layer_shell::left_margin`).

**The minibar's size.** GTK3 sizes a non-resizable window to its size
request, and an empty request (the webview asks for nothing) falls back to
200×200, whatever `inner_size` or `set_size` say. So the bar was a 200×200
window with the pill centred in it, and its transparent rest took the clicks
meant for the windows below. On Linux the bar's GTK window gets the pill's
size as its size request at creation and on each `resize_minibar`
(`keep_above::size_minibar`).

With the window exactly the pill, leaving the pill means leaving the
window, and there WebKitGTK fires no `pointerleave` (nor `mouseleave` or
`mouseout`) on Wayland: a bare WebKitGTK 4.1 test window got `pointerenter`,
then GTK's `leave-notify` and nothing in the page. So the open pill stayed
open. The bar's GTK window reports its `leave-notify` (except into a child
widget) as `minibar-pointer-left` to the bar (`keep_above::report_pointer_leaving`),
and `MinibarPill` ends the hover on it (`pointerLeftWindow`, counted by
`MinibarPage`).

The Linux release leg checks that the deb recommends `libgtk-layer-shell0`
and that `protocol` does not link it.

Checked on KDE Plasma 6.7.5, Wayland, scale 1.75 (the "Protocol QA" build,
KWin's own view of the windows read through a KWin script):

- Keep on top: the pin set KWin's `keepAbove` on the main window (layer 3,
  above the active window, which was another app), unpinning cleared it, and
  it held after the window was hidden for the minibar and shown again. The
  script was loaded while the app ran and gone after it quit.
- Minibar through KWin (gtk-layer-shell not installed, as on this machine):
  the bar was a 172×52 window at the top centre, 12 px down, `keepAbove`,
  `skipTaskbar`, above the active window; hovering opened it to 476 px with
  its left edge in place, and leaving closed it.
- Minibar through layer-shell (gtk-layer-shell 0.10.1 from Ubuntu's
  `libgtk-layer-shell0`, unpacked and put on `LD_LIBRARY_PATH`): KWin saw a
  layer surface 172×52 at the same place; it opened to 476 px and closed
  again, twice in a row; Back to the full window, Stop and the pin worked.
- Before the size fix KWin saw the bar as 200×200, and a bare GTK3 window
  showed the same: non-resizable with no size request, 200×200; resizable or
  with a size request, its size.

Not checked: GNOME (the hidden pin and the window menu's Always on Top),
wlroots compositors, and X11 sessions (no such session on this machine).
