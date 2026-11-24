import {emit} from '@tauri-apps/api/event'
import type {Platform} from '@/lib/platform'
import {audioHandlers} from './audio'
import {notesHandlers} from './notes'
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
    'plugin:window|set_always_on_top': () => null,
    'plugin:window|minimize': () => null,
    'plugin:window|close': () => null,
    'plugin:window|is_maximized': () => mockState.window.maximized,
    'plugin:window|toggle_maximize': () => {
        mockState.window.maximized = !mockState.window.maximized
        // Native code reports the new size as `tauri://resize`; onResized listens to it.
        void emit('tauri://resize', {width: 460, height: 700})
        return null
    },
    // tauri-plugin-dialog: the path the save dialog answers, or null for Cancel.
    'plugin:dialog|save': () => mockState.saveDialogPath,

    // src-tauri/src/onboarding.rs
    get_onboarding_status: () => mockState.onboarding,

    // src-tauri/src/crash_report.rs
    get_pending_crash_report: () => mockState.crashReport,
    create_crash_report_zip: ({destination}) => {
        if (!mockState.crashReport) throw 'No pending crash report is available'
        mockState.crashReportZips.push(String(destination))
        return destination
    },
    dismiss_pending_crash_report: () => {
        mockState.crashReport = null
        return null
    },

    // src-tauri/src/api/api.rs
    open_external_url: ({url}) => {
        // Tauri rejects before the command runs when the argument is missing.
        if (url === undefined) {
            throw 'invalid args `url` for command `open_external_url`: command open_external_url missing required key url'
        }
        const link = String(url)
        if (!link.startsWith('https://') && !link.startsWith('http://')) {
            throw 'Only HTTP and HTTPS links can be opened'
        }
        mockState.openedUrls.push(link)
        return null
    },

    // src-tauri/src/updater/commands.rs
    updater_get_status: () => mockState.updater,

    ...audioHandlers,

    // src-tauri/src/database/repositories/meeting_notes.rs
    ...notesHandlers(mockState),
}

/**
 * Commands native code registers on one platform only (`#[cfg]` in
 * `generate_handler!`; "Windows only" and "macOS only" in PARITY.md). The mock
 * answers one only when `mockState.platform` matches: src/lib/platform.ts sets
 * it (`?platform=` in the browser), and a test or story can change it.
 * Elsewhere it rejects as Tauri does for a command that does not exist, which
 * screens show as "not available". A command is in one of the two maps, never
 * both; ipc.ts refuses to load otherwise.
 */
export const platformHandlers: Record<Platform, Record<string, MockHandler>> = {
    windows: {},
    macos: {},
    linux: {},
}
