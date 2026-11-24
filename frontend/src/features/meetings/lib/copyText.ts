import type {ActionItem} from '@/api/actionItems'
import type {TranscriptSegment} from '@/api/meetings'
import {displaySpeaker, formatClock} from '@/components/transcript/turns'
import {completeSummaryMarkdown, parseSummaryData} from './summaryMarkdown'

/**
 * What Copy transcript and Copy summary put on the clipboard: Markdown with
 * the meeting's title and date, as the old UI's copy did
 * (`162e8be:frontend/src/hooks/meeting-details/useCopyOperations.ts`).
 */
export function meetingDocument(title: string, createdAt: Date | null, sections: [string, string][]): string {
    const date = createdAt?.toLocaleDateString(undefined, {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})
    return [`# ${title}`, ...(date ? [`_${date}_`] : []), ...sections.map(([heading, body]) => `## ${heading}\n\n${body}`)].join('\n\n')
}

/** Every line with its time and voice: `[06:33] **Jay (You):** text`. */
export function transcriptMarkdown(lines: readonly TranscriptSegment[], userName?: string): string {
    return lines
        .map((line) => {
            const time = line.audio_start_time == null ? '' : `[${formatClock(line.audio_start_time)}] `
            const speaker = line.speaker?.trim() ? `**${displaySpeaker(line.speaker.trim(), userName)}:** ` : ''
            return `${time}${speaker}${line.text.trim()}`
        })
        .join('\n\n')
}

/**
 * The summary in whatever format it is stored, with its action items, which
 * live in their own rows since they left the summary text.
 */
export function summaryMarkdown(data: unknown, items: readonly ActionItem[]): string {
    const body = completeSummaryMarkdown(parseSummaryData(data)).trim()
    if (items.length === 0) return body
    const list = items
        .map((item) => {
            const meta = [item.personName ?? item.ownerLabel, item.dueText].filter(Boolean).join(', ')
            return `- [${item.done ? 'x' : ' '}] ${item.text}${meta ? ` (${meta})` : ''}`
        })
        .join('\n')
    return [body, `## Action items\n\n${list}`].filter(Boolean).join('\n\n')
}
