import {waitFor} from '@testing-library/react'
import {emit} from '@tauri-apps/api/event'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {deleteMeetingMutation} from '@/api/meetings'
import {postCallControls, postCallJobs, registerPostCallControls, RETRANSCRIPTION_ERROR_EVENT} from '@/api/postCall'
import {useAutoSummaryStore} from '@/api/preferences'
import {handlers} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {spyOnIpc} from '@/test/ipc'
import {createTestQueryClient} from '@/test/queryClient'
import {runnerControls, RUNNER_TIMING, startPostCall} from './postCallRunner'

const DEFAULT_TIMING = {...RUNNER_TIMING}
const MEETING = 'meeting-roadmap'
const start = () => startPostCall({meetingId: MEETING, folderPath: '/preview/roadmap', audioSaved: true})

let unregister: () => void
beforeEach(() => {
    mockState.postCall.stepMs = 0
    mockState.meetings.summaryRunMs = 0
    Object.assign(RUNNER_TIMING, {summaryPollMs: 1, releasePollMs: 1})
    unregister = registerPostCallControls(runnerControls)
})

afterEach(() => {
    unregister()
    Object.assign(RUNNER_TIMING, DEFAULT_TIMING)
})

describe('the post-call pass', () => {
    it('improves the transcript, finds speakers in it, then writes the summary, one after another', async () => {
        const invoke = spyOnIpc()
        await start()
        expect(postCallJobs.get(MEETING)?.steps).toEqual(['transcript', 'speakers', 'summary'])

        await waitFor(() => expect(postCallJobs.get(MEETING)).toBeNull())
        const commands = invoke.mock.calls.map(([command]) => command)
        expect(commands.indexOf('start_retranscription_command')).toBeLessThan(commands.indexOf('diarize_meeting'))
        expect(commands.indexOf('diarize_meeting')).toBeLessThan(commands.indexOf('api_process_transcript'))
        expect(mockState.meetings.summaries[MEETING].status).toBe('completed')
    })

    it('keeps the live transcript of a meeting whose audio was not saved', async () => {
        useAutoSummaryStore.getState().set(false)
        await startPostCall({meetingId: MEETING, folderPath: '/preview/roadmap', audioSaved: false})
        expect(postCallJobs.get(MEETING)).toBeNull()
    })

    it('waits on a failed step for Retry or Skip', async () => {
        useAutoSummaryStore.getState().set(false)
        const diarize = vi.spyOn(handlers, 'diarize_meeting').mockImplementationOnce(() => {
            throw 'Speaker model is not downloaded'
        })
        await start()

        await waitFor(() => expect(postCallJobs.get(MEETING)).toMatchObject({state: 'failed', step: 'speakers'}))
        expect(postCallJobs.get(MEETING)?.error).toContain('Speaker model is not downloaded')

        postCallControls.retry(MEETING)
        await waitFor(() => expect(postCallJobs.get(MEETING)).toBeNull())
        expect(diarize).toHaveBeenCalledTimes(2)
    })

    it('goes on with the next step when the failed one is skipped', async () => {
        vi.spyOn(handlers, 'start_retranscription_command').mockImplementationOnce(() => {
            throw 'Audio file not found'
        })
        const invoke = spyOnIpc()
        await start()
        await waitFor(() => expect(postCallJobs.get(MEETING)).toMatchObject({state: 'failed', step: 'transcript'}))

        postCallControls.skip(MEETING)

        await waitFor(() => expect(postCallJobs.get(MEETING)).toBeNull())
        expect(invoke.mock.calls.map(([command]) => command)).toContain('diarize_meeting')
    })

    it('hears an error native sends before the start returns', async () => {
        useAutoSummaryStore.getState().set(false)
        vi.spyOn(handlers, 'start_retranscription_command').mockImplementationOnce(async ({meetingId}) => {
            await emit(RETRANSCRIPTION_ERROR_EVENT, {meeting_id: String(meetingId), error: 'Audio file not found'})
            return {meeting_id: String(meetingId), message: 'Retranscription started'}
        })
        await start()

        await waitFor(() => expect(postCallJobs.get(MEETING)).toMatchObject({state: 'failed', step: 'transcript', error: 'Audio file not found'}))
    })

    it('starts the next meeting only once native lets go of the model after the time limit', async () => {
        useAutoSummaryStore.getState().set(false)
        // Native looks at a cancel between chunks: this one notices it 200 ms in.
        mockState.postCall.stepMs = 200
        RUNNER_TIMING.retranscriptionLimitMs = 10
        await start()
        await startPostCall({meetingId: 'meeting-1on1', folderPath: '/preview/1on1', audioSaved: true})
        await waitFor(() => expect(mockState.postCall.retranscribing).toBe(MEETING), {interval: 1})
        // Only the first run is past its limit; the next one runs at full speed.
        RUNNER_TIMING.retranscriptionLimitMs = DEFAULT_TIMING.retranscriptionLimitMs
        mockState.postCall.stepMs = 0

        await waitFor(() => expect(postCallJobs.get(MEETING)).toMatchObject({state: 'failed', step: 'transcript'}))
        expect(postCallJobs.get(MEETING)?.error).toContain('took too long')
        // Started while native still held the first, it would fail with "Retranscription already in progress".
        await waitFor(() => expect(postCallJobs.get('meeting-1on1')).toBeNull())
    })

    it('cancels a running retranscription natively and ends the pass', async () => {
        mockState.postCall.stepMs = 20
        await start()
        await waitFor(() => expect(postCallJobs.get(MEETING)?.state).toBe('running'))

        postCallControls.cancel(MEETING)

        expect(postCallJobs.get(MEETING)?.state).toBe('cancelling')
        await waitFor(() => expect(postCallJobs.get(MEETING)).toBeNull())
        expect(mockState.postCall.retranscribing).toBeNull()
    })

    it('stops waiting for a retranscription that ignores its cancel, and fails with Retry', async () => {
        useAutoSummaryStore.getState().set(false)
        mockState.postCall.stepMs = 200
        Object.assign(RUNNER_TIMING, {retranscriptionLimitMs: 10, releaseLimitMs: 20})
        vi.spyOn(handlers, 'cancel_retranscription_command').mockReturnValue(null)
        await start()
        await startPostCall({meetingId: 'meeting-1on1', folderPath: '/preview/1on1', audioSaved: true})

        await waitFor(() => expect(postCallJobs.get(MEETING)).toMatchObject({state: 'failed', step: 'transcript'}))
        expect(postCallJobs.get(MEETING)?.error).toContain('took too long')
        // Native still holds the model: the next meeting fails visibly instead of waiting for good.
        await waitFor(() => expect(postCallJobs.get('meeting-1on1')).toMatchObject({state: 'failed', error: expect.stringContaining('already in progress')}))
    })

    it('fails a completed retranscription whose model native never lets go of', async () => {
        useAutoSummaryStore.getState().set(false)
        RUNNER_TIMING.releaseLimitMs = 10
        vi.spyOn(handlers, 'is_retranscription_in_progress_command').mockReturnValue(true)
        await start()

        await waitFor(() => expect(postCallJobs.get(MEETING)).toMatchObject({state: 'failed', step: 'transcript'}))
        expect(postCallJobs.get(MEETING)?.error).toContain('still busy')
    })

    it('cancels a summary past its time limit and fails with Retry', async () => {
        mockState.meetings.summaryRunMs = 10_000
        RUNNER_TIMING.summaryLimitMs = 10
        await startPostCall({meetingId: MEETING, folderPath: '/preview/roadmap', audioSaved: false})

        await waitFor(() => expect(postCallJobs.get(MEETING)).toMatchObject({state: 'failed', step: 'summary'}))
        expect(postCallJobs.get(MEETING)?.error).toContain('took too long')
        expect(mockState.meetings.summaries[MEETING].status).toBe('cancelled')
    })

    it('cancels a summary natively when Cancel comes while it starts', async () => {
        mockState.meetings.summaryRunMs = 50
        const startSummary = handlers.api_process_transcript
        vi.spyOn(handlers, 'api_process_transcript').mockImplementationOnce((args) => {
            postCallControls.cancel(MEETING)
            return startSummary(args)
        })
        await startPostCall({meetingId: MEETING, folderPath: '/preview/roadmap', audioSaved: false})

        await waitFor(() => expect(postCallJobs.get(MEETING)).toBeNull())
        await waitFor(() => expect(mockState.meetings.summaries[MEETING].status).toBe('cancelled'))
    })

    it('keeps a pass that is cancelling until native lets go, whatever cancels it again', async () => {
        useAutoSummaryStore.getState().set(false)
        mockState.postCall.stepMs = 20
        await start()
        await startPostCall({meetingId: 'meeting-1on1', folderPath: '/preview/1on1', audioSaved: true})
        await waitFor(() => expect(mockState.postCall.retranscribing).toBe(MEETING))

        postCallControls.cancel(MEETING)
        postCallControls.cancel(MEETING)

        expect(postCallJobs.get(MEETING)?.state).toBe('cancelling')
        await waitFor(() => expect(postCallJobs.get(MEETING)).toBeNull())
        mockState.postCall.stepMs = 0
        // Started while native still held the first, it would fail with "Retranscription already in progress".
        await waitFor(() => expect(postCallJobs.get('meeting-1on1')).toBeNull())
    })

    it('cancels the pass of a meeting before deleting it', async () => {
        useAutoSummaryStore.getState().set(false)
        mockState.postCall.stepMs = 20
        const invoke = spyOnIpc()
        await start()
        await startPostCall({meetingId: 'meeting-1on1', folderPath: '/preview/1on1', audioSaved: true})
        await waitFor(() => expect(mockState.postCall.retranscribing).toBe(MEETING))
        const client = createTestQueryClient()
        const remove = (meetingId: string) => client.getMutationCache().build(client, deleteMeetingMutation(meetingId)).execute(undefined)

        await remove('meeting-1on1')
        expect(postCallJobs.get('meeting-1on1')).toBeNull()
        await remove(MEETING)

        const commands = invoke.mock.calls.map(([command]) => command)
        expect(commands.indexOf('cancel_retranscription_command')).toBeGreaterThan(-1)
        expect(commands.indexOf('cancel_retranscription_command')).toBeLessThan(commands.lastIndexOf('api_delete_meeting'))
        await waitFor(() => expect(postCallJobs.get(MEETING)).toBeNull())
        await waitFor(() => expect(mockState.postCall.retranscribing).toBeNull())
        expect(invoke.mock.calls.filter(([command, args]) => command === 'start_retranscription_command'
            && (args as { meetingId?: string }).meetingId === 'meeting-1on1')).toEqual([])
    })

    it('runs one meeting at a time', async () => {
        useAutoSummaryStore.getState().set(false)
        mockState.postCall.stepMs = 5
        await start()
        await startPostCall({meetingId: 'meeting-1on1', folderPath: '/preview/1on1', audioSaved: true})

        expect(postCallJobs.get('meeting-1on1')?.state).toBe('queued')
        await waitFor(() => expect(postCallJobs.get(MEETING)).toBeNull())
        await waitFor(() => expect(postCallJobs.get('meeting-1on1')).toBeNull())
    })
})
