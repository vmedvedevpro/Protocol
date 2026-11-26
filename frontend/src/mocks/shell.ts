import {emit} from '@tauri-apps/api/event'
import type {MockHandler} from './handlers'
import {mockState} from './state'

/**
 * What the window shell (src/app/shell) asks of native code: the window
 * plugin's calls from the title bar, the save dialog of the crash report,
 * whether first launch is done, and the crash report itself. Its fields sit
 * inline in `createMockState` (`window`, `onboarding`, `crashReport`,
 * `crashReportZips`, `saveDialogPath`), so these read `mockState`.
 */
export const shellHandlers: Record<string, MockHandler> = {
    'plugin:window|set_always_on_top': () => null,
    'plugin:window|set_title': () => null,
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
}
