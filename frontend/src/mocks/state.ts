import type {PendingCrashReport} from '@/api/crashReport'
import type {OnboardingStatus} from '@/api/onboarding'
import type {SystemAudioPermission} from '@/api/permissions'
import type {UpdaterSnapshot} from '@/api/updater'
import {platform} from '@/lib/platform'
import packageJson from '../../package.json'
import {createMockDevices} from './devices'
import {createMockModels} from './models'
import {createMockNotes} from './notes'
import {createMockPreferences} from './preferences'

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
        // The main window as the window plugin sees it.
        window: {maximized: false},
        // A machine that finished first launch; a test or story of first
        // launch sets it to null (a new install).
        onboarding: {completed: true} as OnboardingStatus | null,
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
        // `meeting_notes` rows by meeting id (src/mocks/notes.ts).
        meetingNotes: createMockNotes(),
        // Audio devices and the stored recording preferences (src/mocks/devices.ts).
        devices: createMockDevices(platform),
        // The summary model and the meeting language native holds (src/mocks/preferences.ts).
        preferences: createMockPreferences(),
        // Speech and summary models (src/mocks/models.ts), all installed;
        // `?models=fresh` in pnpm dev starts without them.
        models: createMockModels({fresh: new URLSearchParams(window.location.search).get('models') === 'fresh'}),
        // What the system answers (src/mocks/permissions.ts): the microphone
        // opens; on macOS the Audio Capture record, what its first prompt is
        // answered with, and whether audio plays while a probe listens.
        // `openedPanes` records the settings panes opened, for tests.
        permissions: {
            microphone: true,
            systemAudio: 'granted' as SystemAudioPermission,
            answer: 'granted' as SystemAudioPermission,
            audioPlaying: true,
            openedPanes: [] as string[],
        },
    }
}

export type MockState = ReturnType<typeof createMockState>

export const mockState: MockState = createMockState()

/** Back to the initial state; tests and stories call it before each case. */
export function resetMockState() {
    Object.assign(mockState, createMockState())
}
