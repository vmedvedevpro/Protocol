import type {PendingCrashReport} from '@/api/crashReport'
import type {OnboardingStatus} from '@/api/onboarding'
import type {UpdaterSnapshot} from '@/api/updater'
import {platform} from '@/lib/platform'
import packageJson from '../../package.json'

/**
 * Everything the mock IPC answers from, and nothing a handler does not read.
 * Handlers read and change it the way native code changes the database, so a
 * mutation shows up on the next query. Sample data is typed with the payload
 * types in src/api; see docs/UI_ARCHITECTURE.md, Mock IPC.
 */
function createMockState() {
    const updater: UpdaterSnapshot = {
        currentVersion: packageJson.version,
        platform,
        // What a `tauri dev` build reports.
        support: {kind: 'off', reason: 'dev'},
        autoCheck: true,
        lastCheckedAt: null,
        activity: {state: 'idle'},
        offer: null,
        error: null,
        busyReasons: [],
        updatedFrom: null,
    }

    // A machine that finished first launch with every model downloaded; a
    // test or story of first launch sets `onboarding` to null (a new install).
    const onboarding: OnboardingStatus = {
        version: '1.0',
        completed: true,
        current_step: 4,
        model_status: {parakeet: 'downloaded', summary: 'downloaded'},
        last_updated: '2026-11-24T09:00:00Z',
    }

    return {
        appVersion: packageJson.version,
        // The main window as the window plugin sees it.
        window: {maximized: false},
        onboarding: onboarding as OnboardingStatus | null,
        // What the previous session left (`crashReport`; null after a clean
        // exit), the ZIPs written from it, and what the save dialog answers
        // (null: the user cancelled).
        crashReport: null as PendingCrashReport | null,
        crashReportZips: [] as string[],
        saveDialogPath: '/home/user/Protocol-crash.zip' as string | null,
        // Which platform-only commands answer (`platformHandlers`). Starts as
        // the page's platform; a test or story of a Windows- or macOS-only
        // screen sets it before rendering.
        platform,
        // Links `open_external_url` opened, in order, instead of a browser tab
        // (jsdom has no window.open); `__PROTOCOL_MOCK__.state` in pnpm dev.
        openedUrls: [] as string[],
        updater,
        // Fake audio levels (src/mocks/audio.ts): the devices the preview
        // monitors (null while it is stopped), and a level from 0 to 1 that
        // holds both sources still instead of the fake conversation.
        audio: {
            monitoring: null as string[] | null,
            level: null as number | null,
        },
    }
}

export type MockState = ReturnType<typeof createMockState>

export const mockState: MockState = createMockState()

/** Back to the initial state; tests and stories call it before each case. */
export function resetMockState() {
    Object.assign(mockState, createMockState())
}
