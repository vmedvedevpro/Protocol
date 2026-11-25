import type {TranscriptSegment} from '@/api/meetings'
import {completeSummaryMarkdown, parseSummaryData} from '@/lib/summaryMarkdown'
import {displaySpeaker, formatClock} from './turns'

/**
 * A meeting as Markdown, for Copy transcript and Copy summary and for
 * Export (#119): the title and date over its sections, as the old UI's copy
 * and export did (`162e8be:frontend/src/hooks/meeting-details/useCopyOperations.ts`).
 * The date is a plain line: the old `_date_` italics came out as literal
 * underscores in the PDF, Word and text exports, which render no italics.
 */
export function meetingDocument(title: string, createdAt: Date | null, sections: [string, string][]): string {
    const date = createdAt?.toLocaleDateString(undefined, {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'})
    return [`# ${title}`, ...(date ? [date] : []), ...sections.map(([heading, body]) => `## ${heading}\n\n${body}`)].join('\n\n')
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

/** The summary in whatever format it is stored, its action section included (#218). */
export function summaryMarkdown(data: unknown): string {
    return completeSummaryMarkdown(parseSummaryData(data)).trim()
}
