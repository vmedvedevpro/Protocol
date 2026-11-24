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
        updater,
    }
}

export type MockState = ReturnType<typeof createMockState>

export const mockState: MockState = createMockState()

/** Back to the initial state; tests and stories call it before each case. */
export function resetMockState() {
    Object.assign(mockState, createMockState())
}
