import {getCurrentWindow} from '@tauri-apps/api/window'
import type {ThemeName} from '@/styles/theme'

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

/**
 * Calls `handler` after every resize of this window, maximizing and
 * restoring included, until the returned function is called.
 */
export function onWindowResized(handler: () => void): () => void {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => getCurrentWindow().onResized(handler))().then(
        (stop) => {
            if (disposed) stop()
            else unlisten = stop
        },
        (error: unknown) => console.warn('Failed to follow the window size:', error),
    )
    return () => {
        disposed = true
        unlisten?.()
    }
}

/** Keeps the window above every other window, or stops. */
export async function setWindowAlwaysOnTop(onTop: boolean): Promise<void> {
    await getCurrentWindow().setAlwaysOnTop(onTop)
}
