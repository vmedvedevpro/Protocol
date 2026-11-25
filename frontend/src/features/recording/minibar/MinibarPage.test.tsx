import {fireEvent, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {handlers} from '@/mocks/handlers'
import {installMockIpc} from '@/mocks/ipc'
import type {MockRecording} from '@/mocks/live'
import {mockState} from '@/mocks/state'
import {session} from '../store/session'
import {renderRecording} from '../test/renderRecording'
import {MinibarPage} from './MinibarPage'
import {ShrinkButton} from './ShrinkButton'

/** A mock recording `seconds` in, as native holds it while the bar shows. */
function recordFor(seconds: number): MockRecording {
    const recording: MockRecording = {
        meetingName: 'Weekly sync',
        folderPath: '/home/user/Protocol/Weekly_sync',
        micDevice: null,
        systemDevice: null,
        startedAt: Date.now() - seconds * 1000,
        pausedAt: null,
        pausedMs: 0,
        micMuted: false,
        systemMuted: false,
        lines: [],
    }
    mockState.live.recording = recording
    mockState.minibar.open = true
    return recording
}

async function renderMinibar() {
    const result = renderRecording(<MinibarPage/>, {path: '/minibar'})
    const pill = await screen.findByRole('group', {name: 'Recording controls'})
    return {...result, pill}
}

describe('MinibarPage', () => {
    beforeEach(() => {
        // The minibar window, as minibar.rs labels it.
        window.history.replaceState(null, '', '/minibar')
        installMockIpc()
        return () => window.history.replaceState(null, '', '/')
    })

    it('shows the native timer, the status and Stop, and opens the rest on hover', async () => {
        recordFor(12 * 60 + 4)
        const {pill} = await renderMinibar()

        expect(within(pill).getByRole('timer', {name: 'Recording time'})).toHaveTextContent('12:04')
        expect(within(pill).getByRole('status')).toHaveTextContent('Recording')
        expect(within(pill).getByRole('button', {name: 'Stop and save'})).toBeInTheDocument()
        expect(within(pill).queryByRole('button', {name: 'Mute microphone'})).not.toBeInTheDocument()

        await userEvent.hover(pill)
        expect(within(pill).getByRole('button', {name: 'Mute microphone'})).toBeInTheDocument()
        expect(within(pill).getByRole('button', {name: 'Mute computer audio'})).toBeInTheDocument()
        expect(within(pill).getByRole('button', {name: 'Back to the full window'})).toBeInTheDocument()

        await userEvent.unhover(pill)
        await waitFor(() => expect(within(pill).queryByRole('button', {name: 'Mute microphone'})).not.toBeInTheDocument())
    })

    it('opens for the keyboard and stays open while its focus is inside', async () => {
        recordFor(30)
        const {pill} = await renderMinibar()

        await userEvent.tab()
        // The ring first; Pause in what opened does the same.
        expect(within(pill).getAllByRole('button', {name: 'Pause recording'})[0]).toHaveFocus()
        expect(within(pill).getByRole('button', {name: 'Mute microphone'})).toBeInTheDocument()
    })

    it('pauses from the ring and follows native into Paused', async () => {
        const recording = recordFor(30)
        const {pill} = await renderMinibar()

        await userEvent.click(within(pill).getAllByRole('button', {name: 'Pause recording'})[0])

        await waitFor(() => expect(within(pill).getByRole('status')).toHaveTextContent('Paused'))
        expect(recording.pausedAt).not.toBeNull()
        await userEvent.click(within(pill).getAllByRole('button', {name: 'Resume recording'})[0])
        await waitFor(() => expect(within(pill).getByRole('status')).toHaveTextContent('Recording'))
    })

    it('mutes each source natively and shows Muted', async () => {
        const recording = recordFor(30)
        const {pill} = await renderMinibar()
        await userEvent.hover(pill)

        await userEvent.click(within(pill).getByRole('button', {name: 'Mute microphone'}))

        expect(await within(pill).findByRole('button', {name: 'Muted microphone'})).toHaveAttribute('aria-pressed', 'true')
        expect(recording).toMatchObject({micMuted: true, systemMuted: false})
        await userEvent.click(within(pill).getByRole('button', {name: 'Mute computer audio'}))
        await waitFor(() => expect(recording.systemMuted).toBe(true))
    })

    it('follows a pause and a mute made elsewhere by its poll', async () => {
        recordFor(30)
        const {pill} = await renderMinibar()

        await handlers.pause_recording({})
        await handlers.set_microphone_muted({muted: true})

        await waitFor(() => expect(within(pill).getByRole('status')).toHaveTextContent('Paused'))
        await userEvent.hover(pill)
        expect(within(pill).getByRole('button', {name: 'Muted microphone'})).toBeInTheDocument()
    })

    it('stops through native and shows Finishing… without the controls', async () => {
        recordFor(30)
        const stop = vi.spyOn(handlers, 'stop_recording_from_minibar')
        const {pill} = await renderMinibar()
        await userEvent.hover(pill)

        await userEvent.click(within(pill).getByRole('button', {name: 'Stop and save'}))

        expect(stop).toHaveBeenCalledOnce()
        await waitFor(() => expect(within(pill).getByRole('status')).toHaveTextContent('Finishing…'))
        expect(within(pill).queryByRole('button')).not.toBeInTheDocument()
        expect(within(pill).getByRole('timer')).toHaveTextContent('0:30')
        // The main window saves: native handed the stop over as it does for any Stop.
        expect(mockState.live.recording).toBeNull()
        expect(mockState.minibar.open).toBe(false)
    })

    it('says so when Stop fails and keeps recording', async () => {
        recordFor(30)
        vi.spyOn(handlers, 'stop_recording_from_minibar').mockImplementation(() => {
            throw 'Failed to stop'
        })
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const {pill} = await renderMinibar()

        await userEvent.click(within(pill).getByRole('button', {name: 'Stop and save'}))

        await waitFor(() => expect(within(pill).getByRole('status')).toHaveTextContent('Could not stop'))
        expect(within(pill).getByRole('button', {name: 'Stop and save'})).toBeInTheDocument()
    })

    it('goes back to the full window', async () => {
        recordFor(30)
        const {pill} = await renderMinibar()
        await userEvent.hover(pill)

        await userEvent.click(within(pill).getByRole('button', {name: 'Back to the full window'}))

        await waitFor(() => expect(mockState.minibar.open).toBe(false))
        expect(mockState.live.recording).not.toBeNull()
    })

    it('fits the window to the pill as it opens and closes', async () => {
        // jsdom lays nothing out: report the width an open pill would have.
        let width = 169.4
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({width}) as DOMRect)
        const observers: ResizeObserverCallback[] = []
        vi.stubGlobal('ResizeObserver', class {
            callback: ResizeObserverCallback
            constructor(callback: ResizeObserverCallback) {
                this.callback = callback
                observers.push(callback)
            }
            observe() {
                this.callback([], this as unknown as ResizeObserver)
            }
            disconnect() {}
        })
        try {
            recordFor(30)
            await renderMinibar()
            await waitFor(() => expect(mockState.minibar.width).toBe(170))

            width = 431.2
            observers.forEach((callback) => callback([], {} as ResizeObserver))
            await waitFor(() => expect(mockState.minibar.width).toBe(432))
        } finally {
            vi.unstubAllGlobals()
            vi.restoreAllMocks()
        }
    })

    it('resizes the window once the pill’s width settles, not on every frame of its animation', async () => {
        let width = 169.4
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({width}) as DOMRect)
        const observers: ResizeObserverCallback[] = []
        vi.stubGlobal('ResizeObserver', class {
            callback: ResizeObserverCallback
            constructor(callback: ResizeObserverCallback) {
                this.callback = callback
                observers.push(callback)
            }
            observe() {
                this.callback([], this as unknown as ResizeObserver)
            }
            disconnect() {}
        })
        const resize = vi.spyOn(handlers, 'resize_minibar')
        try {
            recordFor(30)
            await renderMinibar()
            await waitFor(() => expect(mockState.minibar.width).toBe(170))
            resize.mockClear()

            // An opening: the width climbs frame by frame, one report each.
            for (const step of [200, 260, 330, 400, 431.2]) {
                width = step
                observers.forEach((callback) => callback([], {} as ResizeObserver))
            }
            await waitFor(() => expect(mockState.minibar.width).toBe(432))
            // The window opened to its widest at the first step, so the pill never
            // grew into a clip, then fit it once settled.
            expect(resize.mock.calls.map(([args]) => args.width)).toEqual([512, 432])
        } finally {
            vi.unstubAllGlobals()
            vi.restoreAllMocks()
        }
    })

    it('changes its status under a veil, never fading the text', async () => {
        recordFor(30)
        const {pill} = await renderMinibar()

        const text = within(pill).getByRole('status').firstElementChild as HTMLElement
        expect(text).toHaveTextContent('Recording')
        expect(text.style.opacity).toBe('')
        expect(text.querySelector('span[aria-hidden="true"]')).not.toBeNull()
    })

    it('moves the window from a press on the pill, not on its buttons', async () => {
        recordFor(30)
        const {pill} = await renderMinibar()

        fireEvent.mouseDown(within(pill).getByRole('timer'), {button: 0})
        await waitFor(() => expect(mockState.minibar.drags).toBe(1))
        fireEvent.mouseDown(within(pill).getByRole('button', {name: 'Stop and save'}), {button: 0})
        fireEvent.mouseDown(pill, {button: 2})
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(mockState.minibar.drags).toBe(1)
    })

    it('pauses on Space and stops on the stop shortcut', async () => {
        const recording = recordFor(30)
        await renderMinibar()

        await userEvent.keyboard(' ')
        await waitFor(() => expect(recording.pausedAt).not.toBeNull())

        await userEvent.keyboard('{Control>}r{/Control}')
        await waitFor(() => expect(mockState.live.recording).toBeNull())
    })
})

describe('ShrinkButton', () => {
    it('shrinks the main window into the minibar during a recording', async () => {
        recordFor(42)
        mockState.minibar.open = false
        session.set({phase: 'recording', clock: {seconds: 42, at: Date.now()}})
        renderRecording(<ShrinkButton/>)

        await userEvent.click(screen.getByRole('button', {name: 'Shrink to floating bar'}))

        await waitFor(() => expect(mockState.minibar.open).toBe(true))
        expect(mockState.minibar.entered).toEqual([42])
    })
})
