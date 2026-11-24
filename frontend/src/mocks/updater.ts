import {emit} from '@tauri-apps/api/event'
import {type Release, UPDATER_STATUS_EVENT, type UpdateSupport, type UpdaterSnapshot} from '@/api/updater'
import type {Platform} from '@/lib/platform'
import packageJson from '../../package.json'
import type {MockHandler} from './handlers'

/** The updater's part of the mock state: the snapshot, and what a check finds. */
export interface MockUpdaterState {
    updater: UpdaterSnapshot
    /** The newer release a check offers; null for none (up to date). */
    updateRelease: Release | null
}

// How long a check takes and how often a download moves, so the states show
// in pnpm dev and Storybook; tests run them back to back.
const STEP_MS = import.meta.env.MODE === 'test' ? 0 : 700
const DOWNLOAD_STEPS = 10

/** How each platform's installer installs itself (`InstallKind` in updater/support.rs). */
const INSTALL: Record<Platform, string> = {windows: 'nsis', macos: 'app', linux: 'appImage'}

/**
 * An installed copy that has not checked yet, so Settings › Updates can be
 * tried on the mock: Check now finds `updateRelease`, Download moves to
 * ready, Restart and update starts the install. A test or story of a
 * development build sets `support` to `{kind: 'off', reason: 'dev'}`.
 */
export function createMockUpdater(platform: Platform): UpdaterSnapshot {
    return {
        currentVersion: packageJson.version,
        platform,
        support: {kind: 'updatable', install: INSTALL[platform]},
        autoCheck: true,
        lastCheckedAt: null,
        activity: {state: 'idle'},
        offer: null,
        error: null,
        busyReasons: [],
        updatedFrom: null,
    }
}

/** A release in the changelog's form: what the release feed carries as notes. */
export function createMockUpdateRelease(): Release {
    return {
        version: '0.7.0',
        date: '2026-11-30',
        notes: `A new window, one size for every screen, and settings that fit in it.

### Changed

- **A compact window** ([#123](https://github.com/vmedvedevpro/Protocol/issues/123)). Protocol opens at 460 × 700
  and stays beside your call. Pin it to keep it on top.
- **Simple settings.** Your name, the theme, the microphone and summaries on one
  page; the rest is behind **Advanced**.

### Fixed

- The recording bar no longer jumps when the microphone is muted.`,
    }
}

const STALE = 'superseded'

/**
 * The handlers of src-tauri/src/updater/commands.rs, spread into `handlers`
 * with the mock state. Each change is pushed as `updater-status`, as native
 * pushes it, and each command answers with the snapshot it left. A running
 * check or download gives up when anything else changes the snapshot (another
 * command, a test's reset), so it never writes into a later test.
 */
export function updaterHandlers(state: MockUpdaterState): Record<string, MockHandler> {
    const publish = (patch: Partial<UpdaterSnapshot>) => {
        state.updater = {...state.updater, ...patch}
        // After clearMocks() at the end of a test there is no IPC to send to.
        emit(UPDATER_STATUS_EVENT, state.updater).catch(() => undefined)
        return state.updater
    }
    /** Waits a step; rejects if the snapshot changed meanwhile. */
    const step = (since: UpdaterSnapshot) =>
        new Promise<void>((resolve, reject) =>
            setTimeout(() => (state.updater === since ? resolve() : reject(STALE)), STEP_MS),
        )
    const manualOnly = (support: UpdateSupport) => support.kind === 'manualOnly'

    const download = async (since: UpdaterSnapshot, total: number) => {
        let current = since
        for (let done = 1; done <= DOWNLOAD_STEPS; done++) {
            await step(current)
            const received = Math.round((total * done) / DOWNLOAD_STEPS)
            current = publish({activity: {state: 'downloading', received, total}})
        }
        await step(current)
        if (state.updater.offer) publish({activity: {state: 'idle'}, offer: {...state.updater.offer, downloaded: true}})
    }

    return {
        updater_get_status: () => state.updater,
        updater_check_now: async () => {
            const {support, activity} = state.updater
            if (support.kind === 'off' || activity.state !== 'idle') return state.updater
            const checking = publish({activity: {state: 'checking', manual: true}, error: null})
            try {
                await step(checking)
            } catch {
                return state.updater
            }
            const release = state.updateRelease
            return publish({
                activity: {state: 'idle'},
                lastCheckedAt: Date.now(),
                offer: release
                    ? {release, downloaded: false, manualOnly: manualOnly(support), waitingForRecording: false}
                    : null,
            })
        },
        updater_download_now: () => {
            const {offer, activity} = state.updater
            if (!offer || offer.downloaded || offer.manualOnly || activity.state !== 'idle') return state.updater
            const total = 48 * 1024 * 1024
            const started = publish({activity: {state: 'downloading', received: 0, total}, error: null})
            download(started, total).catch(() => undefined)
            return started
        },
        updater_install_now: () => {
            if (!state.updater.offer?.downloaded || state.updater.activity.state !== 'idle') throw {kind: 'notReady'}
            if (state.updater.busyReasons.length > 0) throw {kind: 'busy', reasons: state.updater.busyReasons}
            // Native restarts the app from here; the mock stays on the install.
            return publish({activity: {state: 'installing'}})
        },
        updater_set_auto_check: ({enabled}) => publish({autoCheck: Boolean(enabled)}),
    }
}
