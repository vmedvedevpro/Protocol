import {getCurrentWindow} from '@tauri-apps/api/window'
import {platform} from '@/lib/platform'
import type {ThemeName} from '@/styles/theme'
import {command} from './core'
import {type NativeEvent, subscribeNative} from './events'

// Each call is async so that getCurrentWindow(), which throws outside Tauri,
// rejects instead; callers expect a rejection. Every call needs its
// `core:window:allow-*` permission in tauri.conf.json.

/**
 * Forces the native window theme (title bar, and the webview's
 * `prefers-color-scheme`), or with `null` hands it back to the OS. Under
 * Tauri the media query reports the window's theme, so it follows the OS only
 * while nothing is forced.
 *
 * On Linux tao's `setTheme(null)` forces light instead, so native code takes
 * the mode there and follows the desktop's colour scheme itself
 * (`linux_desktop/theme.rs`, #198).
 */
export async function setWindowTheme(theme: ThemeName | null): Promise<void> {
    if (platform === 'linux') {
        await command<void>('linux_set_window_theme', {theme})
        return
    }
    await getCurrentWindow().setTheme(theme)
}

/** Names the window in its title bar, the task manager and the window switcher. */
export async function setWindowTitle(title: string): Promise<void> {
    await getCurrentWindow().setTitle(title)
}

/**
 * Minimizes the window. Native code turns a minimized main window into the
 * minibar while a recording runs (lib.rs, `on_window_event`).
 */
export async function minimizeWindow(): Promise<void> {
    await getCurrentWindow().minimize()
}

export async function toggleMaximizeWindow(): Promise<void> {
    await getCurrentWindow().toggleMaximize()
}

/** Asks to close; native code hides the main window to the tray instead (lib.rs). */
export async function closeWindow(): Promise<void> {
    await getCurrentWindow().close()
}

export async function isWindowMaximized(): Promise<boolean> {
    return getCurrentWindow().isMaximized()
}

/** Tauri's own event for a window's new size, which `onResized` listens to. */
const WINDOW_RESIZED_EVENT = 'tauri://resize' as NativeEvent<unknown>

/**
 * Calls `handler` after every resize of the main window, maximizing and
 * restoring included, until the returned function is called.
 */
export const onWindowResized = (handler: () => void) =>
    // The caption buttons that follow it exist in the main window only.
    subscribeNative(WINDOW_RESIZED_EVENT, () => handler(), {target: 'main'})

/**
 * Keeps the window above every other window, or stops. On Linux native code
 * picks the way the session allows (`linux_desktop/keep_above.rs`, #199):
 * GTK's keep-above on X11, a KWin script on KDE Plasma's Wayland.
 */
export async function setWindowAlwaysOnTop(onTop: boolean): Promise<void> {
    if (platform === 'linux') {
        await command<void>('linux_set_keep_on_top', {onTop})
        return
    }
    await getCurrentWindow().setAlwaysOnTop(onTop)
}

/**
 * Whether Keep on top can work here. Not on Wayland outside KDE Plasma, where
 * no client can keep its window on top (GNOME's window menu offers Always on
 * Top instead).
 */
export async function getKeepOnTopAvailable(): Promise<boolean> {
    if (platform !== 'linux') return true
    return command<boolean>('linux_keep_on_top_available')
}
