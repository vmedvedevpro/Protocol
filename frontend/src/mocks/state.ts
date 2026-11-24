import type {UpdaterSnapshot} from '@/api/updater'
import {platform} from '@/lib/platform'
import packageJson from '../../package.json'
import * as fixtures from './fixtures'

/**
 * Everything the mock IPC answers from. Handlers read and change it the way
 * native code changes the database, so a mutation shows up on the next query.
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
        meetings: fixtures.meetings.map((meeting) => ({...meeting})),
        groups: fixtures.groups.map((group) => ({...group})),
        people: fixtures.people.map((person) => ({...person})),
        speakerLinks: fixtures.speakerLinks.map((link) => ({...link})),
    }
}

export type MockState = ReturnType<typeof createMockState>

export const mockState: MockState = createMockState()

/** Back to the fixtures; tests call it before each case. */
export function resetMockState() {
    Object.assign(mockState, createMockState())
}
