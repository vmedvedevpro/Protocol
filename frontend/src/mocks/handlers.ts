import type {Platform} from '@/lib/platform'
import {mockState} from './state'

export type MockArgs = Record<string, unknown>
export type MockHandler = (args: MockArgs) => unknown

/**
 * Mock replies by command name: the Rust `#[tauri::command]` name, or
 * `plugin:<plugin>|<command>` for what @tauri-apps/api sends to a plugin. A
 * handler gets the invoke arguments and returns the reply, or a promise of it;
 * throwing rejects the call, as an `Err` from Rust does.
 */
export const handlers: Record<string, MockHandler> = {
    // @tauri-apps/api
    'plugin:app|version': () => mockState.appVersion,
    'plugin:window|set_theme': () => null,

    // src-tauri/src/api/api.rs
    open_external_url: ({url}) => {
        const link = String(url)
        if (!link.startsWith('https://') && !link.startsWith('http://')) {
            throw 'Only HTTP and HTTPS links can be opened'
        }
        window.open(link, '_blank', 'noopener')
        return null
    },

    // src-tauri/src/updater/commands.rs
    updater_get_status: () => mockState.updater,
}

/**
 * Commands native code registers on one platform only (`#[cfg]` in
 * `generate_handler!`; "Windows only" and "macOS only" in PARITY.md). The mock
 * answers one only when `platform` (src/lib/platform.ts, `?platform=` in the
 * browser) matches. Elsewhere it rejects as Tauri does for a command that does
 * not exist, which screens show as "not available".
 */
export const platformHandlers: Record<Platform, Record<string, MockHandler>> = {
    windows: {},
    macos: {},
    linux: {},
}
