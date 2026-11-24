import {getCurrentWindow} from '@tauri-apps/api/window'
import type {ThemeName} from '@/styles/theme'

/**
 * Forces the native window theme (title bar, and the webview's
 * `prefers-color-scheme`), or with `null` hands it back to the OS. Under
 * Tauri the media query reports the window's theme, so it follows the OS only
 * while nothing is forced.
 */
export async function setWindowTheme(theme: ThemeName | null): Promise<void> {
    // async: getCurrentWindow() throws outside Tauri, and callers expect a rejection.
    await getCurrentWindow().setTheme(theme)
}
