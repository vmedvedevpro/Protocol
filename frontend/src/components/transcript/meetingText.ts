import type {ActionItem} from '@/api/actionItems'
import type {TranscriptSegment} from '@/api/meetings'
import {completeSummaryMarkdown, parseSummaryData} from '@/lib/summaryMarkdown'
import {displaySpeaker, formatClock} from './turns'

/**
 * A meeting as Markdown, for Copy transcript and Copy summary and for
 * Export (#119): the title and date over its sections, as the old UI's copy
 * and export did (`162e8be:frontend/src/hooks/meeting-details/useCopyOperations.ts`).
 */
export function meetingDocument(title: string, createdAt: Date | null, sections: [string, string][]): string {
    const date = createdAt?.toLocaleDateString(undefined, {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})
    return [`# ${title}`, ...(date ? [`_${date}_`] : []), ...sections.map(([heading, body]) => `## ${heading}\n\n${body}`)].join('\n\n')
}

/**
 * Every line with its time and voice: `[06:33] **Jay (You):** text`.
 * `speakerName` writes a line's label instead of `displaySpeaker`, as
 * Export's Obsidian links do.
 */
export function transcriptMarkdown(
    lines: readonly TranscriptSegment[],
    userName?: string,
    speakerName: (speaker: string) => string = (speaker) => displaySpeaker(speaker, userName),
): string {
    return lines
        .map((line) => {
            const time = line.audio_start_time == null ? '' : `[${formatClock(line.audio_start_time)}] `
            const speaker = line.speaker?.trim() ? `**${speakerName(line.speaker.trim())}:** ` : ''
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
