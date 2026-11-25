import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {settleIpc} from '@/test/ipc'
import {session} from '../store/session'
import {startRecording} from '../store/start'
import {renderRecording} from '../test/renderRecording'
import {RecordingBar} from './RecordingBar'
import {RecordingRuntime} from './RecordingRuntime'

/** The bar with the runtime that feeds it, as the shell mounts both. */
const renderBar = (idle = false) => renderRecording(<><RecordingRuntime/><RecordingBar idle={idle}/></>)

describe('RecordingBar', () => {
    it('offers Record with the inputs while idle, only where the screen docks it', async () => {
        const {rerender} = renderBar(true)
        const bar = screen.getByRole('group', {name: 'Record'})
        expect(bar).toHaveTextContent('Ready to record')
        expect(await within(bar).findByRole('button', {name: 'Inputs: Default microphone + all apps. Change'})).toBeInTheDocument()
        expect(within(bar).getByRole('button', {name: /Record/})).toBeEnabled()

        rerender(<><RecordingRuntime/><RecordingBar idle={false}/></>)
        expect(screen.queryByRole('group', {name: 'Record'})).not.toBeInTheDocument()
    })

    it('names the default for a saved microphone that is not on this computer, and says it is missing', async () => {
        mockState.devices.recordingPreferences = {...mockState.devices.recordingPreferences, preferred_mic_device: 'Intel Smart Sound Microphone (input)'}
        renderBar(true)
        const bar = screen.getByRole('group', {name: 'Record'})
        const inputs = await within(bar).findByRole('button', {name: 'Inputs: Default microphone + all apps. Intel Smart Sound Microphone isn’t connected. Change'})
        expect(inputs).toHaveTextContent('Default microphone + all apps · Intel Smart Sound Microphone isn’t connected')

        await userEvent.click(inputs)
        expect(await screen.findByRole('menuitemradio', {name: 'System default (Intel Smart Sound Microphone isn’t connected)'})).toBeChecked()
    })

    it('records from Record, then shows the timer, both sources and Stop on any screen', async () => {
        renderBar(true)
        await userEvent.click(await screen.findByRole('button', {name: /Record/}))

        const bar = await screen.findByRole('group', {name: 'Recording'})
        expect(within(bar).getByRole('timer', {name: 'Recording time'})).toHaveTextContent('0:00')
        expect(within(bar).getByRole('button', {name: 'Mute microphone'})).toBeInTheDocument()
        expect(within(bar).getByRole('button', {name: 'Mute computer audio'})).toBeInTheDocument()
        expect(within(bar).getByRole('button', {name: /Stop/})).toBeInTheDocument()
        expect(mockState.live.recording).not.toBeNull()
    })

    it('pauses and resumes from the ring, and mutes each source on its own', async () => {
        renderBar()
        await startRecording()
        const bar = await screen.findByRole('group', {name: 'Recording'})

        await userEvent.click(within(bar).getByRole('button', {name: 'Pause recording'}))
        await waitFor(() => expect(session.get().phase).toBe('paused'))
        expect(within(bar).getByText('Paused')).toBeInTheDocument()
        expect(mockState.live.recording?.pausedAt).not.toBeNull()
        await userEvent.click(within(bar).getByRole('button', {name: 'Resume recording'}))
        await waitFor(() => expect(session.get().phase).toBe('recording'))

        await userEvent.click(within(bar).getByRole('button', {name: 'Mute computer audio'}))
        expect(await within(bar).findByRole('button', {name: 'Muted computer audio'})).toHaveAttribute('aria-pressed', 'true')
        expect(within(bar).getByRole('button', {name: 'Mute microphone'})).toHaveAttribute('aria-pressed', 'false')
        expect(mockState.live.recording).toMatchObject({systemMuted: true, micMuted: false})
    })

    it('stops from Stop and says what the save is doing', async () => {
        renderBar()
        await startRecording()
        const bar = await screen.findByRole('group', {name: 'Recording'})
        // A short take, so the save ends at once.
        await userEvent.click(within(bar).getByRole('button', {name: /Stop/}))

        await waitFor(() => expect(mockState.live.saveAnswers).toEqual([{stopId: 1, outcome: 'discarded'}]))
        await settleIpc()
        expect(screen.queryByRole('group', {name: 'Recording'})).not.toBeInTheDocument()
    })

    it('says recording is unavailable when native cannot answer', async () => {
        const {handlers} = await import('@/mocks/handlers')
        const original = handlers.is_recording
        handlers.is_recording = () => {
            throw 'recording manager unavailable'
        }
        try {
            renderBar(true)
            expect(await screen.findByText('Recording is unavailable')).toBeInTheDocument()
            expect(screen.getByRole('button', {name: /Record/})).toBeDisabled()
        } finally {
            handlers.is_recording = original
        }
    })
})
