import {waitFor} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {postCallControls, postCallJobs, registerPostCallControls} from '@/api/postCall'
import {useAutoSummaryStore} from '@/api/preferences'
import {handlers} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {spyOnIpc} from '@/test/ipc'
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

    it('cancels a running retranscription natively and ends the pass', async () => {
        mockState.postCall.stepMs = 20
        await start()
        await waitFor(() => expect(postCallJobs.get(MEETING)?.state).toBe('running'))

        postCallControls.cancel(MEETING)

        expect(postCallJobs.get(MEETING)?.state).toBe('cancelling')
        await waitFor(() => expect(postCallJobs.get(MEETING)).toBeNull())
        expect(mockState.postCall.retranscribing).toBeNull()
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
