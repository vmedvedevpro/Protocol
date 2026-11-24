import {describe, expect, it, vi} from 'vitest'
import {createMockUpdateRelease} from '@/mocks/updater'
import {mockState} from '@/mocks/state'
import {CommandError} from './core'
import {listenNative} from './events'
import {
    checkForUpdates,
    downloadPercent,
    downloadUpdate,
    installUpdate,
    installRefusal,
    setUpdateAutoCheck,
    UPDATER_STATUS_EVENT,
    type UpdaterSnapshot,
} from './updater'

/** Every `updater-status` the mock pushes, in order. */
async function recordSnapshots() {
    const snapshots: UpdaterSnapshot[] = []
    await listenNative(UPDATER_STATUS_EVENT, (snapshot) => snapshots.push(snapshot))
    return snapshots
}

const ready = (): UpdaterSnapshot => ({
    ...mockState.updater,
    offer: {release: createMockUpdateRelease(), downloaded: true, manualOnly: false, waitingForRecording: false},
})

describe('the updater commands', () => {
    it('checks, pushing the check and then the offer it found', async () => {
        const snapshots = await recordSnapshots()

        const after = await checkForUpdates()

        expect(after.offer?.release.version).toBe('0.7.0')
        expect(after.lastCheckedAt).not.toBeNull()
        expect(snapshots.map(({activity}) => activity.state)).toEqual(['checking', 'idle'])
        expect(snapshots.at(-1)).toEqual(after)
    })

    it('finds nothing newer when there is no release', async () => {
        mockState.updateRelease = null

        await expect(checkForUpdates()).resolves.toMatchObject({offer: null, activity: {state: 'idle'}})
    })

    it('downloads only when asked, then offers the install', async () => {
        await checkForUpdates()
        const snapshots = await recordSnapshots()

        const started = await downloadUpdate()

        expect(started.activity).toMatchObject({state: 'downloading', received: 0})
        await vi.waitFor(() => expect(mockState.updater.offer?.downloaded).toBe(true))
        const percents = snapshots.map(({activity}) => downloadPercent(activity)).filter((p) => p !== null)
        expect(percents).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
        expect(mockState.updater.activity).toEqual({state: 'idle'})
    })

    it('keeps downloading when the daily check is switched meanwhile', async () => {
        await checkForUpdates()
        await downloadUpdate()

        await setUpdateAutoCheck(false)

        await vi.waitFor(() => expect(mockState.updater.offer?.downloaded).toBe(true))
        expect(mockState.updater).toMatchObject({autoCheck: false, activity: {state: 'idle'}})
    })

    it('refuses to install with nothing downloaded', async () => {
        const install = installUpdate()

        await expect(install).rejects.toBeInstanceOf(CommandError)
        await expect(install).rejects.toMatchObject({detail: {kind: 'notReady'}})
    })

    it('refuses to install during work, naming it', async () => {
        mockState.updater = {...ready(), busyReasons: ['recording']}

        const refusal = await installUpdate().catch(installRefusal)

        expect(refusal).toEqual({kind: 'busy', reasons: ['recording']})
        expect(mockState.updater.activity).toEqual({state: 'idle'})
    })

    it('installs a downloaded release', async () => {
        mockState.updater = ready()

        await expect(installUpdate()).resolves.toMatchObject({activity: {state: 'installing'}})
    })

    it('stores the daily check and pushes it', async () => {
        const snapshots = await recordSnapshots()

        await setUpdateAutoCheck(false)

        expect(mockState.updater.autoCheck).toBe(false)
        expect(snapshots.at(-1)?.autoCheck).toBe(false)
    })
})

describe('downloadPercent', () => {
    it('is the share received, or null without a size', () => {
        expect(downloadPercent({state: 'downloading', received: 512, total: 2048})).toBe(25)
        expect(downloadPercent({state: 'downloading', received: 512, total: null})).toBeNull()
        expect(downloadPercent({state: 'idle'})).toBeNull()
    })
})

describe('installRefusal', () => {
    it('reads a refusal from a rejected command, and nothing from other errors', () => {
        expect(installRefusal(new CommandError('updater_install_now', {kind: 'busy', reasons: ['summary']})))
            .toEqual({kind: 'busy', reasons: ['summary']})
        expect(installRefusal(new CommandError('updater_install_now', 'The installer could not start'))).toBeNull()
        expect(installRefusal(new Error('IPC failed'))).toBeNull()
    })
})
