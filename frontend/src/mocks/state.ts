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

    return {
        appVersion: packageJson.version,
        // Which platform-only commands answer (`platformHandlers`). Starts as
        // the page's platform; a test or story of a Windows- or macOS-only
        // screen sets it before rendering.
        platform,
        // Links `open_external_url` opened, in order, instead of a browser tab
        // (jsdom has no window.open); `__PROTOCOL_MOCK__.state` in pnpm dev.
        openedUrls: [] as string[],
        updater,
    }
}

export type MockState = ReturnType<typeof createMockState>

export const mockState: MockState = createMockState()

/** Back to the initial state; tests and stories call it before each case. */
export function resetMockState() {
    Object.assign(mockState, createMockState())
}
