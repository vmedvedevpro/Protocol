import {describe, expect, it} from 'vitest'
import type {ActionItem} from '@/api/actionItems'
import type {TranscriptSegment} from '@/api/meetings'
import {meetingDocument, summaryMarkdown, transcriptMarkdown} from './meetingText'

const line = (text: string, start: number | undefined, speaker?: string): TranscriptSegment =>
    ({id: text, text, timestamp: '', audio_start_time: start, speaker})

const item = (text: string, extra: Partial<ActionItem> = {}): ActionItem => ({
    id: text, meetingId: 'm', meetingTitle: '', meetingCreatedAt: '', text, done: false, source: 'ai', edited: false,
    position: 0, createdAt: '', updatedAt: '', ...extra,
})

describe('copied text', () => {
    it('writes each line with its time and voice, the user by name', () => {
        expect(transcriptMarkdown([line(' Hello ', 4, 'You'), line('Hi', 3725, 'Speaker 2'), line('Old line', undefined)], 'Jay'))
            .toBe('[00:04] **Jay (You):** Hello\n\n[1:02:05] **Speaker 2:** Hi\n\nOld line')
    })

    it('adds the action items to the summary, done or not, with owner and due date', () => {
        expect(summaryMarkdown({markdown: '## Decisions\n\n- Ship it'}, [
            item('Send the terms', {ownerLabel: 'Priya', dueText: 'Friday'}),
            item('Book the room', {done: true}),
        ])).toBe('## Decisions\n\n- Ship it\n\n## Action items\n\n- [ ] Send the terms (Priya, Friday)\n- [x] Book the room')
    })

    it('heads the document with the title and the date', () => {
        expect(meetingDocument('Standup', null, [['Summary', 'Body']])).toBe('# Standup\n\n## Summary\n\nBody')
        expect(meetingDocument('Standup', new Date(2026, 10, 25), [])).toMatch(/^# Standup\n\n_.*2026.*_$/)
    })
})
