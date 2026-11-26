import {describe, expect, it} from 'vitest'
import type {TranscriptSegment} from '@/api/meetings'
import {meetingDocument, summaryMarkdown, transcriptMarkdown} from './meetingText'

const line = (text: string, start: number | undefined, speaker?: string): TranscriptSegment =>
    ({id: text, text, timestamp: '', audio_start_time: start, speaker})

describe('copied text', () => {
    it('writes each line with its time and voice, the user by name', () => {
        expect(transcriptMarkdown([line(' Hello ', 4, 'You'), line('Hi', 3725, 'Speaker 2'), line('Old line', undefined)], 'Jay'))
            .toBe('[00:04] **Jay (You):** Hello\n\n[1:02:05] **Speaker 2:** Hi\n\nOld line')
    })

    it('copies the summary with the action items it lists, and nothing else', () => {
        const markdown = '## Decisions\n\n- Ship it\n\n## Action Items\n\n- Priya: Send the terms (due Friday)'
        expect(summaryMarkdown({markdown: `${markdown}\n`, original_markdown: 'older text'})).toBe(markdown)
    })

    it('heads the document with the title and the date', () => {
        expect(meetingDocument('Standup', null, [['Summary', 'Body']])).toBe('# Standup\n\n## Summary\n\nBody')
        expect(meetingDocument('Standup', new Date(2026, 10, 25), [])).toMatch(/^# Standup\n\n[^_*]*2026[^_*]*$/)
    })
})
