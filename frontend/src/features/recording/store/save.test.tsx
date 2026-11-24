import {waitFor} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {postCallJobs} from '@/api/postCall'
import {useAutoSummaryStore} from '@/api/preferences'
import {speakMockLine} from '@/mocks/live'
import {mockState} from '@/mocks/state'
import {spyOnIpc} from '@/test/ipc'
import {listRecoverable} from '../api/recovery'
import {RecordingRuntime} from '../components/RecordingRuntime'
import {renderRecording, toastTitles} from '../test/renderRecording'
import {registerLinks} from './links'
import {setLiveNotes} from './liveNotes'
import {SAVE_TIMING, stopRecording} from './save'
import {session} from './session'
import {startRecording} from './start'

const DEFAULT_TIMING = {...SAVE_TIMING}

/** Starts a recording through the runtime, speaks `lines` of the script and sets the timer to `seconds`. */
async function record({lines = 3, seconds = 120} = {}) {
    renderRecording(<RecordingRuntime/>)
    expect(await startRecording()).toBe(true)
    for (let line = 0; line < lines; line++) speakMockLine(mockState)
    await waitFor(() => expect(session.get().lines).toHaveLength(lines))
    session.set({clock: {seconds, at: Date.now()}})
    return session.get().recoveryId!
}

beforeEach(() => {
    // The waits keep their order and shrink to milliseconds.
    Object.assign(SAVE_TIMING, {pollMs: 1, limitMs: 50, lateLinesMs: 0, settleMs: 0})
    mockState.postCall.stepMs = 0
    useAutoSummaryStore.getState().set(false)
})

afterEach(() => {
    Object.assign(SAVE_TIMING, DEFAULT_TIMING)
})

describe('Stop and save', () => {
    it('saves the meeting with its lines, notes and folder, answers native, then opens it and improves it', async () => {
        const openMeeting = vi.fn()
        const invoke = spyOnIpc()
        const recoveryId = await record()
        registerLinks({openRecording: () => {}, openMeeting, openSpeechModels: () => {}})
        const folder = mockState.meetings.folders[0]
        session.set({folder: {id: folder.id, name: folder.name}})
        setLiveNotes({markdown: 'Ship the export dialog', json: []})

        await stopRecording()

        await waitFor(() => expect(mockState.live.saveAnswers).toEqual([{stopId: 1, outcome: 'saved'}]))
        const meeting = mockState.meetings.meetings.at(-1)!
        expect(meeting.title).toMatch(/^Meeting · /)
        expect(meeting.folder_path).toMatch(/Meeting_/)
        expect(mockState.meetings.transcripts[meeting.id].map((line) => line.speaker)).toEqual(['You', 'Speaker 2', 'Speaker 3'])
        expect(mockState.meetingNotes[meeting.id]?.markdown).toBe('Ship the export dialog')
        expect(openMeeting).toHaveBeenCalledWith(meeting.id)
        expect(session.get().phase).toBe('idle')
        // Saved: the crash copy is no longer offered.
        expect((await listRecoverable(Date.now() + 60_000)).map((copy) => copy.meetingId)).not.toContain(recoveryId)

        // The pass after it: retranscription, then speakers, then nothing left.
        await waitFor(() => expect(postCallJobs.get(meeting.id)).toBeNull())
        const commands = invoke.mock.calls.map(([command]) => command)
        expect(commands.indexOf('start_retranscription_command')).toBeLessThan(commands.indexOf('diarize_meeting'))
    })

    it('discards a take under 10 seconds', async () => {
        const recoveryId = await record({seconds: 4})
        const before = mockState.meetings.meetings.length

        await stopRecording()

        await waitFor(() => expect(mockState.live.saveAnswers).toEqual([{stopId: 1, outcome: 'discarded'}]))
        expect(mockState.live.discarded).toHaveLength(1)
        expect(mockState.meetings.meetings).toHaveLength(before)
        expect((await listRecoverable(Date.now() + 60_000)).map((copy) => copy.meetingId)).not.toContain(recoveryId)
        expect(toastTitles()).toContain('Recording cancelled')
    })

    it('saves nothing when transcription does not finish in time, and keeps the copy for recovery', async () => {
        const recoveryId = await record()
        mockState.live.transcription = {chunks_in_queue: 2, is_processing: true, last_activity_ms: 0}
        const before = mockState.meetings.meetings.length

        await stopRecording()

        await waitFor(() => expect(mockState.live.saveAnswers).toEqual([{stopId: 1, outcome: 'notSaved'}]))
        expect(mockState.meetings.meetings).toHaveLength(before)
        expect((await listRecoverable(Date.now() + 60_000)).map((copy) => copy.meetingId)).toContain(recoveryId)
        expect(toastTitles()).toContain('The meeting was not saved')
    })

    it('ends the wait undone when the status cannot be read', async () => {
        await record()
        const status = vi.spyOn(await import('@/mocks/handlers').then((module) => module.handlers), 'get_transcription_status')
            .mockImplementation(() => {
                throw 'transcription worker gone'
            })

        await stopRecording()

        await waitFor(() => expect(mockState.live.saveAnswers).toEqual([{stopId: 1, outcome: 'notSaved'}]))
        status.mockRestore()
    })

    it('neither opens the meeting nor starts its pass when Protocol quits after the save', async () => {
        const openMeeting = vi.fn()
        await record()
        registerLinks({openRecording: () => {}, openMeeting, openSpeechModels: () => {}})
        mockState.live.quitting = true

        await stopRecording()

        await waitFor(() => expect(mockState.live.saveAnswers).toEqual([{stopId: 1, outcome: 'saved'}]))
        const meeting = mockState.meetings.meetings.at(-1)!
        expect(openMeeting).not.toHaveBeenCalled()
        expect(postCallJobs.get(meeting.id)).toBeNull()
    })
})
