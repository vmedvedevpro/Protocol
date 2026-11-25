import {describe, expect, it, vi} from 'vitest'
import {MOCK_RETRANSCRIPTION_READINGS} from '@/mocks/postCall'
import {mockState} from '@/mocks/state'
import {settleIpc, spyOnIpc} from '@/test/ipc'
import {subscribeNative} from './events'
import {
    cancelRetranscription,
    diarizeMeeting,
    isRetranscriptionInProgress,
    postCallControls,
    postCallJobs,
    registerPostCallControls,
    RETRANSCRIPTION_COMPLETE_EVENT,
    RETRANSCRIPTION_ERROR_EVENT,
    RETRANSCRIPTION_PROGRESS_EVENT,
    startRetranscription,
} from './postCall'

describe('the post-call jobs', () => {
    it('queue, run, take readings, fail and end', () => {
        postCallJobs.queue('m1', ['transcript', 'speakers', 'summary'])
        expect(postCallJobs.get('m1')).toMatchObject({state: 'queued', step: 'transcript', reading: null})

        postCallJobs.run('m1', 'transcript')
        postCallJobs.progress('m1', 140, 1_000)
        expect(postCallJobs.get('m1')).toMatchObject({state: 'running', reading: {percent: 100, at: 1_000}})

        postCallJobs.run('m1', 'speakers')
        expect(postCallJobs.get('m1')).toMatchObject({reading: null, paceFrom: null})
        postCallJobs.fail('m1', 'No audio file')
        expect(postCallJobs.get('m1')).toMatchObject({state: 'failed', error: 'No audio file'})

        postCallJobs.end('m1')
        expect(postCallJobs.get('m1')).toBeNull()
    })

    it('ignore writes to a meeting without a job', () => {
        postCallJobs.run('nobody', 'speakers')
        postCallJobs.fail('nobody', 'x')
        expect(postCallJobs.get('nobody')).toBeNull()
    })

    it('measure the pace from the start of the chunks, after the model has loaded', () => {
        postCallJobs.queue('m1', ['transcript'])
        postCallJobs.run('m1', 'transcript')
        postCallJobs.progress('m1', 5, 0)
        postCallJobs.progress('m1', 15, 2_000)
        expect(postCallJobs.get('m1')?.paceFrom).toBeNull()
        // 25 as the model loads, and 25 again as the first chunk starts.
        postCallJobs.progress('m1', 25, 3_000)
        postCallJobs.progress('m1', 25, 20_000)
        postCallJobs.progress('m1', 30, 30_000)
        expect(postCallJobs.get('m1')?.paceFrom).toEqual({percent: 25, at: 20_000})
    })

    it('measure from the first reading inside the chunks after a re-attach', () => {
        postCallJobs.queue('m1', ['transcript'])
        postCallJobs.run('m1', 'transcript')
        postCallJobs.progress('m1', 50, 7_000)
        postCallJobs.progress('m1', 55, 9_000)
        expect(postCallJobs.get('m1')?.paceFrom).toEqual({percent: 50, at: 7_000})
    })
})

describe('the post-call controls', () => {
    it('forward to the registered runner, and to nothing once it is gone', async () => {
        const runner = {cancel: vi.fn(), retry: vi.fn(), skip: vi.fn(), afterImport: vi.fn(), settled: vi.fn(() => Promise.resolve())}
        const unregister = registerPostCallControls(runner)
        postCallControls.cancel('m1')
        postCallControls.retry('m1')
        postCallControls.skip('m1')
        postCallControls.afterImport('m1')
        expect(runner.afterImport).toHaveBeenCalledWith('m1')
        expect(runner.cancel).toHaveBeenCalledWith('m1')
        expect(runner.retry).toHaveBeenCalledWith('m1')
        expect(runner.skip).toHaveBeenCalledWith('m1')

        unregister()
        postCallControls.cancel('m1')
        expect(runner.cancel).toHaveBeenCalledTimes(1)
        // Without a runner nothing holds native work, so a delete need not wait.
        await expect(postCallControls.settled('m1')).resolves.toBeUndefined()
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
        const progress: { stage: string, percent: number }[] = []
        const done = vi.fn()
        const stopProgress = subscribeNative(RETRANSCRIPTION_PROGRESS_EVENT, (event) =>
            progress.push({stage: event.stage, percent: event.progress_percentage}))
        const stopDone = subscribeNative(RETRANSCRIPTION_COMPLETE_EVENT, done)
        await settleIpc()

        await startRetranscription({meetingId: 'm1', meetingFolderPath: '/rec/m1', language: null, model: null, provider: null})
        expect(await isRetranscriptionInProgress('m1')).toBe(true)
        await expect(startRetranscription({meetingId: 'm2', meetingFolderPath: '/rec/m2', language: null, model: null, provider: null}))
            .rejects.toThrow('Retranscription already in progress')
        await vi.waitFor(() => expect(done).toHaveBeenCalledWith(expect.objectContaining({meeting_id: 'm1'})))
        // In native's bands: decoding and speech detection, the chunks from 25 to 80, the save.
        expect(progress).toEqual(MOCK_RETRANSCRIPTION_READINGS)
        expect(await isRetranscriptionInProgress('m1')).toBe(false)
        stopProgress()
        stopDone()
    })

    it('end a cancelled retranscription with an error event', async () => {
        mockState.postCall.stepMs = 5
        const failed = vi.fn()
        const stop = subscribeNative(RETRANSCRIPTION_ERROR_EVENT, failed)
        await settleIpc()

        // Native checks the meeting first, even with nothing running.
        await expect(cancelRetranscription('m1')).rejects.toThrow('This meeting has no active retranscription')
        await startRetranscription({meetingId: 'm1', meetingFolderPath: '/rec/m1', language: null, model: null, provider: null})
        await expect(cancelRetranscription('m2')).rejects.toThrow('This meeting has no active retranscription')
        await cancelRetranscription('m1')
        await vi.waitFor(() => expect(failed).toHaveBeenCalledWith({meeting_id: 'm1', error: 'Retranscription cancelled'}))
        stop()
    })
})
