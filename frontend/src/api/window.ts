import {getCurrentWindow} from '@tauri-apps/api/window'
import type {ThemeName} from '@/styles/theme'
import {type NativeEvent, subscribeNative} from './events'

// Each call is async so that getCurrentWindow(), which throws outside Tauri,
// rejects instead; callers expect a rejection. Every call needs its
// `core:window:allow-*` permission in tauri.conf.json.

/**
 * Forces the native window theme (title bar, and the webview's
 * `prefers-color-scheme`), or with `null` hands it back to the OS. Under
 * Tauri the media query reports the window's theme, so it follows the OS only
 * while nothing is forced.
 */
export async function setWindowTheme(theme: ThemeName | null): Promise<void> {
    await getCurrentWindow().setTheme(theme)
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

/** Keeps the window above every other window, or stops. */
export async function setWindowAlwaysOnTop(onTop: boolean): Promise<void> {
    await getCurrentWindow().setAlwaysOnTop(onTop)
}
