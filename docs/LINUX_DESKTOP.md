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
