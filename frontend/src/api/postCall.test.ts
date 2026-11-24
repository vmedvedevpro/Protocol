import {describe, expect, it, vi} from 'vitest'
import {mockState} from '@/mocks/state'
import {settleIpc, spyOnIpc} from '@/test/ipc'
import {subscribeNative} from './events'
import {
    cancelRetranscription,
    diarizeMeeting,
    formatRemaining,
    isRetranscriptionInProgress,
    postCallControls,
    postCallJobs,
    postCallProgress,
    postCallRemainingMs,
    postCallStatusText,
    registerPostCallControls,
    RETRANSCRIPTION_COMPLETE_EVENT,
    RETRANSCRIPTION_ERROR_EVENT,
    RETRANSCRIPTION_PROGRESS_EVENT,
    startRetranscription,
} from './postCall'

describe('the post-call jobs', () => {
    it('queue, run, report progress, fail and end', () => {
        postCallJobs.queue('m1', ['transcript', 'speakers', 'summary'])
        expect(postCallJobs.get('m1')).toMatchObject({state: 'queued', step: 'transcript', percent: null})
        expect(postCallStatusText(postCallJobs.get('m1')!)).toBe('Waiting for another meeting to finish')

        postCallJobs.run('m1', 'transcript', 1_000)
        postCallJobs.progress('m1', 140)
        expect(postCallJobs.get('m1')).toMatchObject({state: 'running', percent: 100, stepStartedAt: 1_000})

        postCallJobs.run('m1', 'speakers')
        expect(postCallJobs.get('m1')?.percent).toBeNull()
        postCallJobs.fail('m1', 'No audio file')
        expect(postCallStatusText(postCallJobs.get('m1')!)).toBe('Could not find speakers')
        expect(postCallJobs.get('m1')?.error).toBe('No audio file')

        postCallJobs.end('m1')
        expect(postCallJobs.get('m1')).toBeNull()
        expect(postCallJobs.all()).toEqual([])
    })

    it('ignore writes to a meeting without a job', () => {
        postCallJobs.run('nobody', 'speakers')
        postCallJobs.fail('nobody', 'x')
        expect(postCallJobs.get('nobody')).toBeNull()
    })

    it('count "Recording saved" as the first step of the progress', () => {
        postCallJobs.queue('m1', ['transcript', 'speakers', 'summary'])
        expect(postCallProgress(postCallJobs.get('m1')!)).toBe(1 / 4)
        postCallJobs.run('m1', 'transcript')
        postCallJobs.progress('m1', 40)
        expect(postCallProgress(postCallJobs.get('m1')!)).toBeCloseTo(1.4 / 4)
        postCallJobs.run('m1', 'summary')
        expect(postCallProgress(postCallJobs.get('m1')!)).toBe(3 / 4)
    })

    it('estimate the time left only once the step has a pace', () => {
        postCallJobs.queue('m1', ['transcript'])
        postCallJobs.run('m1', 'transcript', 0)
        postCallJobs.progress('m1', 2)
        expect(postCallRemainingMs(postCallJobs.get('m1')!, 60_000)).toBeNull()
        postCallJobs.progress('m1', 25)
        expect(postCallRemainingMs(postCallJobs.get('m1')!, 2_000)).toBeNull()
        // 25 % in 40 s: 120 s to go.
        expect(postCallRemainingMs(postCallJobs.get('m1')!, 40_000)).toBe(120_000)
        expect(formatRemaining(120_000)).toBe('about 2 min')
        expect(formatRemaining(140_000)).toBe('about 2 min')
        expect(formatRemaining(25_000)).toBe('under a minute')
    })
})

describe('the post-call controls', () => {
    it('forward to the registered runner, and to nothing once it is gone', () => {
        const runner = {cancel: vi.fn(), retry: vi.fn(), skip: vi.fn()}
        const unregister = registerPostCallControls(runner)
        postCallControls.cancel('m1')
        postCallControls.retry('m1')
        postCallControls.skip('m1')
        expect(runner.cancel).toHaveBeenCalledWith('m1')
        expect(runner.retry).toHaveBeenCalledWith('m1')
        expect(runner.skip).toHaveBeenCalledWith('m1')

        unregister()
        postCallControls.cancel('m1')
        expect(runner.cancel).toHaveBeenCalledTimes(1)
    })
})

describe('the native post-call commands', () => {
    it('send the arguments native expects', async () => {
        const invoke = spyOnIpc()
        await startRetranscription({meetingId: 'm1', meetingFolderPath: '/rec/m1', language: null, model: 'parakeet-tdt', provider: 'parakeet'})
        expect(invoke).toHaveBeenCalledWith('start_retranscription_command', {
            meetingId: 'm1',
            meetingFolderPath: '/rec/m1',
            language: null,
            model: 'parakeet-tdt',
            provider: 'parakeet',
            vocabularyTerms: null,
            vocabularyScope: null,
        }, undefined)
        await diarizeMeeting('m1', 4)
        expect(invoke).toHaveBeenCalledWith('diarize_meeting', {meetingId: 'm1', numSpeakers: 4}, undefined)
    })

    it('report a retranscription by event until it completes', async () => {
        mockState.postCall.stepMs = 0
        const progress: number[] = []
        const done = vi.fn()
        const stopProgress = subscribeNative(RETRANSCRIPTION_PROGRESS_EVENT, (event) => progress.push(event.progress_percentage))
        const stopDone = subscribeNative(RETRANSCRIPTION_COMPLETE_EVENT, done)
        await settleIpc()

        await startRetranscription({meetingId: 'm1', meetingFolderPath: '/rec/m1', language: null, model: null, provider: null})
        expect(await isRetranscriptionInProgress('m1')).toBe(true)
        await expect(startRetranscription({meetingId: 'm2', meetingFolderPath: '/rec/m2', language: null, model: null, provider: null}))
            .rejects.toThrow('Retranscription already in progress')
        await vi.waitFor(() => expect(done).toHaveBeenCalledWith(expect.objectContaining({meeting_id: 'm1'})))
        expect(progress.at(-1)).toBe(100)
        expect(await isRetranscriptionInProgress('m1')).toBe(false)
        stopProgress()
        stopDone()
    })

    it('end a cancelled retranscription with an error event', async () => {
        mockState.postCall.stepMs = 5
        const failed = vi.fn()
        const stop = subscribeNative(RETRANSCRIPTION_ERROR_EVENT, failed)
        await settleIpc()

        await startRetranscription({meetingId: 'm1', meetingFolderPath: '/rec/m1', language: null, model: null, provider: null})
        await expect(cancelRetranscription('m2')).rejects.toThrow('This meeting has no active retranscription')
        await cancelRetranscription('m1')
        await vi.waitFor(() => expect(failed).toHaveBeenCalledWith({meeting_id: 'm1', error: 'Retranscription cancelled'}))
        stop()
    })
})
