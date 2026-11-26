# The Linux desktop: frame, app id, dark mode, keep on top, tray name

How the main window, the minibar and the tray fit a Linux desktop (#215, which
merged #200, #191, #198, #199 and the tray name). Each part says what the code
does, why, which files own it, how it was checked and what is left.

## Native window frame (#200)

On Linux the main window uses the desktop's own frame:
`tauri.linux.conf.json` repeats the whole window entry with
`"decorations": true` (a platform file replaces the `windows` array, as
`tauri.macos.conf.json` does). `scripts/release/test/tauri-linux-window.test.mjs`
checks that the two entries differ only in `decorations`. Windows stays frameless (`tauri.conf.json`)
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
| Wayland, wlroots (Sway, Hyprland…) | a note in the pin's place | layer-shell overlay if gtk-layer-shell loads, else a plain window that says once it cannot stay on top |
| Wayland, GNOME | a note in the pin's place; the native frame's window menu has Always on Top | a plain window that says once it cannot stay on top |

XWayland for the whole app (`GDK_BACKEND=x11`) would make keep-above work
everywhere but blurs the window on fractional scaling, so it is not used.

**The KWin script.** KWin runs scripts sent over D-Bus
(`org.kde.KWin /Scripting` `loadScript`, then `start`), and a script may
set `keepAbove` on any window. The script matches this process's windows by
pid: the minibar by its title (`Recording`, since Wayland has no
skip-taskbar hint for KWin to read), the main window as every other normal
window. It is loaded only while something needs it: the pin, a minibar kept
above through KWin, or a recording (for the minimize, below). Nothing is
loaded at start unless the saved pin is on. KWin forgets a Wayland window
when it is unmapped, and the main window is hidden while the minibar shows,
so a loaded script also applies to windows added later. It is reloaded with
the new state on each change under one plugin name per program name
(`<app>-keep-above`, so a new start replaces what a crashed run left),
unloaded when nothing needs it any more, and unloaded at `RunEvent::Exit`
under the same lock as the reloads, so a change still in flight cannot load
it again after the exit. For the minibar it also hides it from the task
manager and the switcher and puts it top centre, 12 px down; it can still be
dragged. A bar shown before the reloaded script ran is placed by its first
pass (a new KWin window has `skipTaskbar` unset); one it placed stays where
the user dragged it.

The script is started with `Scripting.start`, not `Script.run` on
`/Scripting/Script<id>`: KWin numbers a script by the count of loaded
scripts, so after an unload the new id can be the one the old script, still
being deleted, holds that path under, and a reload then did not run (seen
on Plasma 6.7: the script reloaded for a new minibar neither kept it above
nor placed it, while the same file under a fresh name did).

`keep_above::script` generates only the parts the state needs, and its unit
tests check the text for each case: nothing pinned (no script), the pin, the
pin going off, the minibar alone, a recording.

**A Keep Above the user set is theirs.** The script raises a main window only
if it is not kept above already, and touches `keepAbove` only while the pin
is on. To undo only its own changes it reports back: the app exports
`io.github.vmedvedevpro.Protocol.KWinScript` at
`/io/github/vmedvedevpro/Protocol/KWinScript` on GLib's shared session-bus
connection (`keep_above::register_callback`, at start on the KWin route),
and the script calls it with KWin's `callDBus` on the connection's unique
name. `Raised(id)` and `Released(id)` (the user turned it off from the window
menu) keep the set of KWin window ids the script raised. When the pin goes
off, the next script clears Keep Above on those ids only; such a release-only
script stays loaded, inert, until the next change or the exit. The object
answers only KWin's unique name. If it cannot be exported, the session counts
as one with no route.

The script file goes to `$XDG_RUNTIME_DIR`, which the XDG spec makes private
to the user. Where it is unset the app refuses rather than write to a shared
directory such as `/tmp`, where another user could have planted a symlink.

**Failures are said.** `linux_set_keep_on_top` returns KWin's error (KWin
scripting disabled makes `loadScript` return a negative id, a D-Bus error,
no `XDG_RUNTIME_DIR`) and keeps the state it had. The frontend then sets the
pin back off and shows a toast with the reason (`useKeepOnTopSync`); a failed
unpin says so too. Where no route exists, the frontend asks
`linux_keep_on_top_available` once and the strip says "Keep on top isn't
available in this session" in the pin's place (`useKeepOnTopAvailable`,
`TitleBar`'s `onTopUnavailable`); `setWindowAlwaysOnTop` calls
`linux_set_keep_on_top` on Linux. A minibar that cannot stay on top (no
route and no layer-shell, or a failed KWin load) says "Can't stay on top" in
its status line, once a run (`linux_take_minibar_notice`, the
`minibar-notice` event; `MinibarPage` also asks once it listens), and the
log gives the reason at warn. A missing `libgtk-layer-shell.so.0` is logged
at warn too.

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
open. Worse, after GTK's leave WebKitGTK sends the page a move at the
pointer's last position inside, so a page that opened the pill on moves
opened it again at once (seen in this round's QA: the page heard the leave
and the pill stayed open).

So on Linux the hover comes from GTK alone. The bar's GTK window reports
`leave-notify` as `minibar-pointer-left` and `enter-notify` as
`minibar-pointer-entered` (except crossings into a child widget,
`keep_above::report_pointer_crossings`), `MinibarPage` keeps whether the
pointer is over the window, and `MinibarPill` takes that as `pointerOver`
and ignores the webview's pointer events. Elsewhere the webview's
`pointerenter` and `pointerleave` count as before.

A drag of the bar (KWin route) leaves the window too: the compositor takes
the pointer for the move. Read with a virtual pointer on Plasma 6.7, the
crossings were: enter (Normal) on hover, leave (Virtual, Ungrab, BUTTON1
held) as the move began, enter (Normal) when it ended, leave (Normal) on the
way out. The old code closed the open pill mid-drag, which changed the
window's width under the pointer (476 px before, 172 px during, 476 px
after). `keep_above::is_pointer_leaving` now reports a leave only in mode
Normal with no button held (X11's window-manager grab gives mode Grab), so
the pill stays open through the drag and closes once the pointer leaves
after it; its unit test covers those cases.

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

Checked in this round on the same session (a "Protocol QA" build of this
branch, KWin's view read through a KWin script, the pin and the recording
driven through AT-SPI, the pointer through a virtual uinput tablet):

- With the pin saved off, nothing was loaded in KWin at start
  (`isScriptLoaded` false).
- Pin on, then off: KWin's `keepAbove` on the main window went true, then
  false (`releases 1 window(s)`); after the window was hidden for the
  minibar and shown again, unpinning cleared it on the new window too
  (`releases 2 window(s)`).
- A Keep Above set as KWin's window menu sets it, with the pin off, stayed
  on through pin on and pin off; the script was then unloaded.
- The minibar on the KWin route through several reloads (pin, recording,
  minimize): kept above, top centre, not in the task manager.
- Dragging the open minibar kept it open (476 px) and moved it; leaving it
  then closed it (172 px), and a hover and leave after that opened and
  closed it again.
- At quit the script was unloaded.

Not checked: GNOME (the note in the pin's place, the minibar's notice and
the window menu's Always on Top), wlroots compositors, X11 sessions (no such
session on this machine), and KWin with scripting disabled (the toast is
covered by `App.test.tsx`).

## Minimizing during a recording

On Windows, macOS and X11, minimizing the main window during a recording
opens the minibar (`lib.rs`, `on_window_event`: a `Resized` event with
`is_minimized()`). On Wayland that never fires: xdg-shell has no minimized
state, so the compositor tells a client nothing when it minimizes its
window, and GDK3 never sets `GDK_WINDOW_STATE_ICONIFIED` there, not even
for its own `gtk_window_iconify` (GTK issue 67,
https://gitlab.gnome.org/GNOME/gtk/-/issues/67; Firefox meets the same in
https://bugzilla.mozilla.org/show_bug.cgi?id=2063202). The xdg-toplevel
`suspended` state that newer compositors send is not exposed by GDK3, and
losing focus or frame callbacks also happen for many other reasons.

Checked on KDE Plasma 6.7.5, Wayland, with the "Protocol QA" build of the
first round: during a recording KWin minimized the main window (KWin's own
`minimized` true) and the minibar did not open; the log showed no
compact-mode call. With this round's build the same minimize opened the
minibar at once, kept above and top centre, and after the recording stopped
the script no longer watched the minimize.

So on Plasma the KWin script reports it: while a recording runs
(`keep_above::recording_changed`, called where `recording_commands.rs`
sets `IS_RECORDING`) it connects `minimizedChanged` on the main window and
calls `Minimized(id)`, and the app opens the minibar as the X11 path does
(`minibar::enter_compact_mode`). The frame's minimize button is KWin's
(server-side decorations), so this is the button's path.

On GNOME and wlroots compositors there is no reliable route. Minimizing
there just minimizes the window: the recording goes on, the tray menu
offers Stop Recording and Open Main Window, and the recording screen's
Shrink to floating bar opens the minibar. GNOME's title bar shows no
minimize button by default, and tiling compositors such as Sway do not
minimize.

## The tray icon's name on hover

The panel names a tray icon on hover from its StatusNotifierItem's
`ToolTip`. Tauri's tray on Linux is libayatana-appindicator through
tray-icon, which ignores `.tooltip()` there. libayatana-appindicator 0.5.94
exports `Title` (GLib's application name, which `tray.rs` sets to the product
name) but no `ToolTip` property at all, and Plasma 6.7 does not fall back to
`Title`: read over D-Bus, Protocol's item had `Title "Protocol QA"` and no
`ToolTip` and showed nothing on hover, while Bitwarden's had an empty `Title`,
a `ToolTip` titled "Bitwarden", and showed its name.

libayatana-appindicator registers its item on GLib's shared session-bus
connection, which `gio::bus_get_sync` returns in the same process.
`linux_desktop/tray_name.rs` adds a filter to that connection: it notes each
incoming `Properties.GetAll("org.kde.StatusNotifierItem")` on an
`/org/ayatana/NotificationItem/` path and adds a `ToolTip` (title: the
product name) to the outgoing reply to it. An error reply ends the call
too: it is let through unchanged and its call is no longer pending. Both Plasma and GNOME's
AppIndicator extension read the item through `GetAll`. A separate
StatusNotifierItem implementation (the `ksni` crate, say) would set
`ToolTip` directly but would replace Tauri's tray, its menu and its icon
updates on Linux.

Checked on KDE Plasma 6.7.5, Wayland: `GetAll` on the "Protocol QA" build's
item returned `ToolTip ("", [], "Protocol QA", "")` beside its other
properties, and hovering the icon in the panel showed "Protocol QA". Not
checked: GNOME with the AppIndicator extension (no GNOME session here).
