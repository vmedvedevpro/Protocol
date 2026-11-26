import {act, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {handlers} from '@/mocks/handlers'
import {emitMockEvent} from '@/mocks/ipc'
import type {MockRecording} from '@/mocks/live'
import {mockState} from '@/mocks/state'
import {settleIpc} from '@/test/ipc'
import {
    AUDIO_ROUTE_WARNING_EVENT,
    TRANSCRIPTION_ERROR_EVENT,
} from '../api/recording'
import {beginRecovery, listRecoverable, setRecoveryFolder, storeRecoveryLine} from '../api/recovery'
import type {TranscriptUpdate} from '../api/transcript'
import {registerLinks} from '../store/links'
import {recoverMeeting} from '../store/recover'
import {session} from '../store/session'
import {startRecording} from '../store/start'
import {renderRecording, toastTitles} from '../test/renderRecording'
import {RecordingRuntime} from './RecordingRuntime'

const line = (sequence: number, text: string, source = 'You'): TranscriptUpdate => ({
    text,
    timestamp: '10:00:00',
    source,
    sequence_id: sequence,
    chunk_start_time: sequence * 3,
    is_partial: false,
    confidence: 0.9,
    audio_start_time: sequence * 3,
    audio_end_time: sequence * 3 + 2,
    duration: 2,
})

afterEach(() => {
    vi.useRealTimers()
})

describe('RecordingRuntime', () => {
    it('joins a recording that runs across a reload of the window', async () => {
        const startedAt = Date.now() - 95_000
        mockState.live.recording = {
            meetingName: 'Weekly Standup — Nov 25',
            folderPath: '/recordings/standup',
            micDevice: null,
            systemDevice: null,
            startedAt,
            pausedAt: Date.now() - 5_000,
            pausedMs: 0,
            micMuted: true,
            systemMuted: false,
            lines: [{id: 'a', text: 'Morning everyone.', audio_start_time: 1, audio_end_time: 3, duration: 2, display_time: '[00:01]', confidence: 0.9, sequence_id: 1, speaker: 'You'}],
        } satisfies MockRecording
        localStorage.setItem('af-live-notes', JSON.stringify({markdown: 'Agenda', json: []}))

        renderRecording(<RecordingRuntime/>)

        await waitFor(() => expect(session.get().phase).toBe('paused'))
        expect(session.get()).toMatchObject({title: 'Weekly Standup — Nov 25', muted: {mic: true, system: false}})
        expect(session.get().clock.seconds).toBeGreaterThanOrEqual(89)
        expect(session.get().lines.map((each) => each.text)).toEqual(['Morning everyone.'])
        expect(session.get().notes?.markdown).toBe('Agenda')
    })

    it('joins a running recording even when native cannot say its state', async () => {
        mockState.live.recording = {
            meetingName: 'Weekly Standup — Nov 25',
            folderPath: '/recordings/standup',
            micDevice: null,
            systemDevice: null,
            startedAt: Date.now() - 95_000,
            pausedAt: null,
            pausedMs: 0,
            micMuted: false,
            systemMuted: false,
            lines: [],
        } satisfies MockRecording
        vi.spyOn(handlers, 'get_recording_state').mockImplementation(() => {
            throw 'Recording manager lock poisoned'
        })

        renderRecording(<RecordingRuntime/>)

        await waitFor(() => expect(session.get().phase).toBe('recording'))
        expect(session.get()).toMatchObject({title: 'Weekly Standup — Nov 25', recoveryId: expect.stringMatching(/^meeting-/)})
    })

    it('stops the recording when the speech model needs the user, and offers Speech models', async () => {
        const openSpeechModels = vi.fn()
        renderRecording(<RecordingRuntime/>)
        await startRecording()
        registerLinks({openRecording: () => {}, openMeeting: () => {}, openSpeechModels})

        await act(() => emitMockEvent(TRANSCRIPTION_ERROR_EVENT, {
            error: 'model integrity check failed',
            userMessage: 'The speech model is damaged. Download it again.',
            actionable: true,
        }))

        await waitFor(() => expect(mockState.live.recording).toBeNull())
        expect(toastTitles()).toContain('The recording stopped')
        // Native then hands the take over, and one this short is discarded. Waiting for
        // that keeps its toast out of the next test on a slow machine.
        await waitFor(() => expect(mockState.live.saveAnswers).toEqual([{stopId: 1, outcome: 'discarded'}]))
        await waitFor(() => expect(toastTitles()).toContain('Recording cancelled'))
    })

    it('shows the audio route warning in the app for 30 seconds', async () => {
        renderRecording(<RecordingRuntime/>)
        await settleIpc()

        await act(() => emitMockEvent(AUDIO_ROUTE_WARNING_EVENT, {title: 'Computer audio is not recorded', message: 'Your headset plays through another device.'}))

        await waitFor(() => expect(toastTitles()).toEqual(['Computer audio is not recorded']))
    })

    it('tells the updater while a save runs, and when it ends', async () => {
        renderRecording(<RecordingRuntime/>)
        await startRecording()
        await waitFor(() => expect(mockState.live.uiActivity).toEqual([]))

        act(() => session.set({phase: 'finishing'}))
        await waitFor(() => expect(mockState.live.uiActivity).toEqual(['recordingSave']))
        act(() => session.clear())
        await waitFor(() => expect(mockState.live.uiActivity).toEqual([]))
    })

    it('offers an interrupted meeting once, and recovers it with its audio', async () => {
        const openMeeting = vi.fn()
        await beginRecovery({meetingId: 'meeting-1', title: 'Design sync', startTime: Date.now() - 600_000})
        await setRecoveryFolder('meeting-1', '/recordings/design-sync')
        await storeRecoveryLine('meeting-1', line(1, 'Let’s look at the onboarding copy.'))
        await storeRecoveryLine('meeting-1', line(2, 'The headline is too long.', 'Speaker 2'))
        // Without lines there is nothing to recover: not offered.
        await beginRecovery({meetingId: 'meeting-2', title: 'Empty', startTime: Date.now() - 600_000})
        mockState.live.checkpoints['/recordings/design-sync'] = true
        // Offered once it has stood still for a while.
        vi.useFakeTimers({toFake: ['Date']})
        vi.setSystemTime(Date.now() + 10_000)

        renderRecording(<RecordingRuntime/>)
        registerLinks({openRecording: () => {}, openMeeting, openSpeechModels: () => {}})

        const sheet = await screen.findByRole('dialog', {name: 'An interrupted meeting'})
        const item = within(sheet).getByRole('listitem', {name: 'Design sync'})
        expect(item).toHaveTextContent('2 lines · audio can be rebuilt')
        expect(await within(item).findByText(/onboarding copy/)).toBeInTheDocument()

        await userEvent.click(within(item).getByRole('button', {name: 'Recover'}))

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        const saved = mockState.meetings.meetings.at(-1)!
        // A copy from before the save recorded `titleManual`: a typed title is the user's.
        expect(saved).toMatchObject({title: 'Design sync', titleIsManual: true, folder_path: '/recordings/design-sync'})
        expect(mockState.meetings.transcripts[saved.id].map((each) => each.text)).toHaveLength(2)
        expect(mockState.live.checkpoints).toEqual({})
        expect(toastTitles()).toContain('Meeting recovered')
        expect(await listRecoverable(Date.now() + 60_000)).toEqual([expect.objectContaining({meetingId: 'meeting-2'})])
    })

    it('takes an automatic title in an older copy as not the user’s', async () => {
        await beginRecovery({meetingId: 'meeting-1', title: 'Meeting · Wed, Nov 25 · 2:34 PM', startTime: Date.now() - 600_000})
        await storeRecoveryLine('meeting-1', line(1, 'Hello.'))
        await beginRecovery({meetingId: 'meeting-2', title: 'Meeting, Wed, Nov 25, 2:34 PM', startTime: Date.now() - 600_000})
        await storeRecoveryLine('meeting-2', line(1, 'Hello.'))

        await recoverMeeting('meeting-1')
        await recoverMeeting('meeting-2')

        expect(mockState.meetings.meetings.slice(-2)).toEqual([
            expect.objectContaining({title: 'Meeting · Wed, Nov 25 · 2:34 PM', titleIsManual: false}),
            expect.objectContaining({title: 'Meeting, Wed, Nov 25, 2:34 PM', titleIsManual: false}),
        ])
    })

    it('tells the updater while a recovery rebuilds the audio and saves', async () => {
        await beginRecovery({meetingId: 'meeting-1', title: 'Design sync', startTime: Date.now() - 600_000})
        await setRecoveryFolder('meeting-1', '/recordings/design-sync')
        await storeRecoveryLine('meeting-1', line(1, 'Hello.'))
        mockState.live.checkpoints['/recordings/design-sync'] = true
        let rebuilt!: () => void
        const recoverAudio = handlers.recover_audio_from_checkpoints
        vi.spyOn(handlers, 'recover_audio_from_checkpoints').mockImplementationOnce(async (args) => {
            await new Promise<void>((resolve) => {
                rebuilt = resolve
            })
            return recoverAudio(args)
        })
        vi.useFakeTimers({toFake: ['Date']})
        vi.setSystemTime(Date.now() + 10_000)

        renderRecording(<RecordingRuntime/>)
        const sheet = await screen.findByRole('dialog', {name: 'An interrupted meeting'})
        await userEvent.click(within(sheet).getByRole('button', {name: 'Recover'}))

        await waitFor(() => expect(mockState.live.uiActivity).toEqual(['recordingSave']))
        rebuilt()
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        await waitFor(() => expect(mockState.live.uiActivity).toEqual([]))
    })

    it('deletes an interrupted meeting only after a confirm', async () => {
        await beginRecovery({meetingId: 'meeting-1', title: 'Design sync', startTime: Date.now() - 600_000})
        await storeRecoveryLine('meeting-1', line(1, 'Hello.'))
        vi.useFakeTimers({toFake: ['Date']})
        vi.setSystemTime(Date.now() + 10_000)

        renderRecording(<RecordingRuntime/>)
        const sheet = await screen.findByRole('dialog')

        await userEvent.click(within(sheet).getByRole('button', {name: 'Delete'}))
        expect(within(sheet).getByText('Delete this meeting for good?')).toBeInTheDocument()
        await userEvent.click(within(sheet).getByRole('button', {name: 'Keep'}))
        await userEvent.click(within(sheet).getByRole('button', {name: 'Delete'}))
        await userEvent.click(within(sheet).getByRole('button', {name: 'Delete'}))

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(await listRecoverable(Date.now() + 60_000)).toEqual([])
    })
})
