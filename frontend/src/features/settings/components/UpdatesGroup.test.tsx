import {createElement} from 'react'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import type {UpdaterSnapshot} from '@/api/updater'
import {createMockUpdateRelease} from '@/mocks/updater'
import {mockState} from '@/mocks/state'
import {renderSettings} from '../testing'
import {UpdatesGroup} from './UpdatesGroup'
import {appUpdateStatus, catalogStatus} from './updateStatus'

// A StatusLine says its text twice: the live region is the copy that counts.
const LIVE = {selector: '[role="status"]'}

const renderUpdates = () => renderSettings(createElement(UpdatesGroup))

const offered = (patch: Partial<UpdaterSnapshot['offer'] & object> = {}): UpdaterSnapshot => ({
    ...mockState.updater,
    offer: {release: createMockUpdateRelease(), downloaded: false, manualOnly: false, waitingForRecording: false, ...patch},
})

// The app's row and Model updates each have a Check button, in that order.
const ROWS = {app: 0, models: 1}
const checkButton = (row: keyof typeof ROWS) => screen.getAllByRole('button', {name: 'Check'})[ROWS[row]]
// Each row shows once its own status has loaded, so wait for both.
const findCheckButton = (row: keyof typeof ROWS) => waitFor(() => {
    const buttons = screen.getAllByRole('button', {name: 'Check'})
    expect(buttons).toHaveLength(2)
    return buttons[ROWS[row]]
})

describe('Updates', () => {
    it('checks, downloads on a click and restarts on another', async () => {
        renderUpdates()
        expect(await screen.findByText(`Protocol ${mockState.updater.currentVersion}`)).toBeInTheDocument()
        expect(screen.getByText('Not checked yet', LIVE)).toBeInTheDocument()

        await userEvent.click(checkButton('app'))
        expect(await screen.findByText('0.7.0 is available', LIVE)).toBeInTheDocument()
        expect(mockState.updater.activity.state).toBe('idle')

        await userEvent.click(screen.getByRole('button', {name: 'Download'}))
        expect(await screen.findByText('0.7.0 is ready to install', LIVE)).toBeInTheDocument()
        expect(screen.getByText(/Protocol closes for about half a minute/)).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Restart and update'}))
        expect(await screen.findByText('Starting the update…', LIVE)).toBeInTheDocument()
    })

    it('says up to date after a check that found nothing', async () => {
        mockState.updateRelease = null
        renderUpdates()

        await userEvent.click(await findCheckButton('app'))

        expect(await screen.findByText('Up to date, checked', LIVE)).toBeInTheDocument()
        expect(screen.getByText('just now')).toBeInTheDocument()
    })

    it('waits for work to end before it restarts, and says why', async () => {
        mockState.updater = {...offered({downloaded: true}), busyReasons: ['summary']}
        renderUpdates()

        expect(await screen.findByRole('button', {name: 'Restart and update'})).toBeDisabled()
        expect(screen.getByText("Protocol can't restart while a summary is being generated.")).toBeInTheDocument()
    })

    it('shows a refusal native gives for work the snapshot did not show yet', async () => {
        mockState.updater = offered({downloaded: true})
        renderUpdates()
        const restart = await screen.findByRole('button', {name: 'Restart and update'})
        mockState.updater = {...mockState.updater, busyReasons: ['recording']}

        await userEvent.click(restart)

        expect(await screen.findByText("Protocol can't restart while a recording is in progress.")).toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('shows the release notes on request', async () => {
        mockState.updater = offered()
        renderUpdates()

        await userEvent.click(await screen.findByRole('button', {name: 'What’s new in 0.7.0'}))

        expect(screen.getByRole('heading', {name: 'Changed'})).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Open on GitHub'}))
        expect(mockState.openedUrls).toEqual(['https://github.com/vmedvedevpro/Protocol/releases/tag/v0.7.0'])
    })

    it('sends a development build to the releases page', async () => {
        mockState.updater = {...mockState.updater, support: {kind: 'off', reason: 'dev'}}
        renderUpdates()

        expect(await screen.findByText('Updates are off in development builds', LIVE)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Open releases'}))
        expect(mockState.openedUrls).toEqual(['https://github.com/vmedvedevpro/Protocol/releases'])
    })

    it('turns the daily check off', async () => {
        renderUpdates()

        await userEvent.click(await screen.findByRole('switch', {name: 'Check for updates automatically'}))

        await waitFor(() => expect(mockState.updater.autoCheck).toBe(false))
        expect(screen.getByRole('switch', {name: 'Check for updates automatically'})).not.toBeChecked()
    })

    it('checks the model list', async () => {
        renderUpdates()

        await userEvent.click(await findCheckButton('models'))

        // The app's own row still says it has not checked.
        expect(await screen.findByText('Up to date, checked', LIVE)).toBeInTheDocument()
        expect(screen.getByText('Not checked yet', LIVE)).toBeInTheDocument()
        expect(mockState.catalog.source).toBe('remote')
    })
})

describe('appUpdateStatus', () => {
    const now = 1_000_000_000

    it('says what each state is', () => {
        expect(appUpdateStatus(offered({manualOnly: true}), now)).toMatchObject({key: 'manual', text: '0.7.0 is available'})
        expect(appUpdateStatus(offered({waitingForRecording: true}), now).text).toBe('0.7.0 downloads after the recording')
        expect(appUpdateStatus({...offered(), activity: {state: 'downloading', received: 30, total: 120}}, now))
            .toEqual({key: 'downloading', text: 'Downloading 0.7.0', value: '25%'})
        expect(appUpdateStatus({...mockState.updater, activity: {state: 'checking', manual: true}}, now))
            .toMatchObject({key: 'checking', busy: true})
    })

    it('puts a failed manual check in the line', () => {
        const error = {kind: 'network', action: 'check', message: '', at: now, background: false} as const
        expect(appUpdateStatus({...mockState.updater, error}, now).text)
            .toBe("Couldn't reach GitHub. Check your connection and try again.")
    })
})

describe('catalogStatus', () => {
    it('counts updates and models it could not check', () => {
        const checked = {...mockState.catalog, lastCheckedAt: 0}
        const update = {engine: 'whisper', id: 'small', fromCommit: 'a', toCommit: 'b', downloadBytes: 1} as const
        const failure = {engine: 'whisper', id: 'small', message: '404'} as const
        expect(catalogStatus({...checked, updates: [update, update]}, 0).text).toBe('2 model updates available')
        expect(catalogStatus({...checked, checkFailures: [failure]}, 0).text).toBe('1 model couldn’t be checked')
        expect(catalogStatus({...checked, error: 'offline'}, 0).key).toBe('failed')
    })
})
