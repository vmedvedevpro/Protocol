import {isTauri} from '@/api/core'

export type Platform = 'macos' | 'windows' | 'linux'

const PLATFORMS: readonly Platform[] = ['macos', 'windows', 'linux']

/**
 * The webview tells the OS apart: WebView2 on Windows, WKWebView on macOS,
 * WebKitGTK on Linux. No native command reports it (tauri-plugin-os is not
 * registered), and the window chrome and shortcut hints need it before the
 * first render.
 */
export function platformFromUserAgent(userAgent: string): Platform {
    if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos'
    if (/Windows/i.test(userAgent)) return 'windows'
    return 'linux'
}

function detectPlatform(): Platform {
    // In a browser on mock IPC, `?platform=macos|windows|linux` previews
    // another platform's chrome and shortcuts.
    if (!isTauri()) {
        const forced = new URLSearchParams(window.location.search).get('platform')
        if (PLATFORMS.includes(forced as Platform)) return forced as Platform
    }
    return platformFromUserAgent(navigator.userAgent)
}

export const platform: Platform = detectPlatform()

/** A shortcut as hints write it: `⌘K` on macOS, `Ctrl K` elsewhere. */
export function formatShortcut(key: string, on: Platform = platform): string {
    return on === 'macos' ? `⌘${key}` : `Ctrl ${key}`
}
