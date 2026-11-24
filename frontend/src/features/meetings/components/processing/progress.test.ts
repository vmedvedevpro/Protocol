import {describe, expect, it} from 'vitest'
import {postCallJobs} from '@/api/postCall'
import {MOCK_RETRANSCRIPTION_READINGS} from '@/mocks/postCall'
import {formatRemaining, postCallProgress, postCallRemainingMs, postCallStatusText} from './progress'

describe('the words for a pass', () => {
    it('say what waits, runs, stops or failed', () => {
        postCallJobs.queue('m1', ['transcript', 'speakers'])
        expect(postCallStatusText(postCallJobs.get('m1')!)).toBe('Waiting for another meeting to finish')
        postCallJobs.run('m1', 'speakers')
        expect(postCallStatusText(postCallJobs.get('m1')!)).toBe('Finding speakers')
        postCallJobs.cancelling('m1')
        expect(postCallStatusText(postCallJobs.get('m1')!)).toBe('Stopping…')
        postCallJobs.fail('m1', 'x')
        expect(postCallStatusText(postCallJobs.get('m1')!)).toBe('Could not find speakers')
    })
})

describe('the progress of a pass', () => {
    it('counts "Recording saved" as the first step', () => {
        postCallJobs.queue('m1', ['transcript', 'speakers', 'summary'])
        expect(postCallProgress(postCallJobs.get('m1')!)).toBe(1 / 4)
        postCallJobs.run('m1', 'transcript')
        postCallJobs.progress('m1', 40)
        expect(postCallProgress(postCallJobs.get('m1')!)).toBeCloseTo(1.4 / 4)
        postCallJobs.run('m1', 'summary')
        expect(postCallProgress(postCallJobs.get('m1')!)).toBe(3 / 4)
    })
})

describe('the time left', () => {
    it('follows the chunks of a retranscription, and nothing before or after them', () => {
        // The mock's readings, 10 s apart: the time left is when 80 % comes.
        const STEP = 10_000
        const reachesEnd = MOCK_RETRANSCRIPTION_READINGS.findIndex(({percent}) => percent >= 80) * STEP
        postCallJobs.queue('m1', ['transcript'])
        postCallJobs.run('m1', 'transcript')

        const estimates = MOCK_RETRANSCRIPTION_READINGS.map(({percent}, index) => {
            postCallJobs.progress('m1', percent, index * STEP)
            return postCallRemainingMs(postCallJobs.get('m1')!, index * STEP)
        })
        const firstChunk = MOCK_RETRANSCRIPTION_READINGS.findIndex(({percent}, index) =>
            percent === 25 && MOCK_RETRANSCRIPTION_READINGS[index + 1]?.percent === 25) + 1

        // Decoding, speech detection and the model's load say nothing.
        expect(estimates.slice(0, firstChunk + 1).every((each) => each === null)).toBe(true)
        // Each chunk's reading tells the true time to the end of the chunks.
        estimates.forEach((estimate, index) => {
            if (index > firstChunk && MOCK_RETRANSCRIPTION_READINGS[index].percent < 80) {
                expect(estimate).toBe(reachesEnd - index * STEP)
            }
        })
        // The save takes a second: no estimate from 80 on.
        expect(estimates.at(-1)).toBeNull()
    })

    it('counts down between readings', () => {
        postCallJobs.queue('m1', ['transcript'])
        postCallJobs.run('m1', 'transcript')
        postCallJobs.progress('m1', 25, 0)
        postCallJobs.progress('m1', 30, 10_000)
        // 5 % in 10 s; 50 % to go: 100 s from the reading.
        expect(postCallRemainingMs(postCallJobs.get('m1')!, 10_000)).toBe(100_000)
        expect(postCallRemainingMs(postCallJobs.get('m1')!, 40_000)).toBe(70_000)
        expect(postCallRemainingMs(postCallJobs.get('m1')!, 500_000)).toBe(0)
    })

    it('waits for a few seconds of pace', () => {
        postCallJobs.queue('m1', ['transcript'])
        postCallJobs.run('m1', 'transcript')
        postCallJobs.progress('m1', 25, 0)
        postCallJobs.progress('m1', 40, 2_000)
        expect(postCallRemainingMs(postCallJobs.get('m1')!, 2_000)).toBeNull()
    })

    it('reads as words', () => {
        expect(formatRemaining(120_000)).toBe('about 2 min')
        expect(formatRemaining(140_000)).toBe('about 2 min')
        expect(formatRemaining(25_000)).toBe('under a minute')
    })
})
