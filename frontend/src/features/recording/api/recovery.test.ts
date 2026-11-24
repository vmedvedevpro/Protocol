import {afterEach, describe, expect, it, vi} from 'vitest'
import type {TranscriptUpdate} from './transcript'
import {
    beginRecovery,
    getRecoveryLines,
    listRecoverable,
    markRecoverySaved,
    pruneRecovery,
    RECOVERY_KEEP_MS,
    RECOVERY_KEEP_SAVED_MS,
    storeRecoveryLine,
} from './recovery'

const update = (sequence: number, text: string): TranscriptUpdate => ({
    text, timestamp: '10:00:00', source: 'You', sequence_id: sequence, chunk_start_time: 0, is_partial: false,
    confidence: 0.9, audio_start_time: sequence, audio_end_time: sequence + 1, duration: 1,
})

afterEach(() => {
    vi.useRealTimers()
})

describe('the recovery copy', () => {
    it('keeps the lines in order and offers an unsaved meeting once it has stood still', async () => {
        await beginRecovery({meetingId: 'meeting-1', title: 'Design sync', startTime: Date.now()})
        await storeRecoveryLine('meeting-1', update(2, 'second'))
        await storeRecoveryLine('meeting-1', update(1, 'first'))

        expect((await getRecoveryLines('meeting-1')).map((line) => line.text)).toEqual(['first', 'second'])
        // Updated a moment ago: perhaps still recording in another window.
        expect(await listRecoverable()).toEqual([])
        expect(await listRecoverable(Date.now() + 5_000)).toEqual([expect.objectContaining({meetingId: 'meeting-1', title: 'Design sync'})])

        await markRecoverySaved('meeting-1')
        expect(await listRecoverable(Date.now() + 5_000)).toEqual([])
    })

    it('prunes copies after 7 days, and saved ones after a day', async () => {
        vi.useFakeTimers({toFake: ['Date']})
        const start = Date.now()
        await beginRecovery({meetingId: 'meeting-old', title: 'Old', startTime: start})
        await beginRecovery({meetingId: 'meeting-saved', title: 'Saved', startTime: start})
        await markRecoverySaved('meeting-saved')
        await beginRecovery({meetingId: 'meeting-new', title: 'New', startTime: start})

        await pruneRecovery(start + RECOVERY_KEEP_SAVED_MS + 1_000)
        vi.setSystemTime(start + RECOVERY_KEEP_SAVED_MS + 1_000)
        expect((await listRecoverable(start + RECOVERY_KEEP_SAVED_MS + 5_000)).map((copy) => copy.meetingId).sort()).toEqual(['meeting-new', 'meeting-old'])

        await pruneRecovery(start + RECOVERY_KEEP_MS + 1_000)
        expect(await listRecoverable(start + RECOVERY_KEEP_MS + 5_000)).toEqual([])
    })
})
