/**
 * What Export writes: the meeting as one Markdown document, which each
 * format then renders (./formats.ts). It follows the old UI's export
 * (`162e8be`: `hooks/meeting-details/useCopyOperations.ts`,
 * `lib/exportMarkdownFrontmatter.ts`): the title and date, the summary with
 * its headings one level down, then the transcript. Only the Markdown file
 * gets the YAML frontmatter and, with Obsidian links, the speakers as
 * wikilinks; the other formats keep plain names.
 */
import type {ActionItem} from '@/api/actionItems'
import type {TranscriptSegment} from '@/api/meetings'
import {meetingDocument, summaryMarkdown, transcriptMarkdown} from '@/components/transcript/meetingText'
import {displaySpeaker, isUnnamedSpeaker, isUserSpeaker, speakerParts} from '@/components/transcript/turns'
import {safely} from '@/lib/storage'

export type ExportContent = 'transcript' | 'summary' | 'both'
export type ExportFormat = 'pdf' | 'docx' | 'txt' | 'markdown' | 'json' | 'clipboard'
export type LinkStyle = 'generic' | 'obsidian'

/** **Keep reading** (PARITY.md): the old UI's key and its two values. */
export const LINK_STYLE_KEY = 'meetily_export_link_style'

export const readLinkStyle = (): LinkStyle =>
    safely(() => localStorage.getItem(LINK_STYLE_KEY)) === 'obsidian' ? 'obsidian' : 'generic'

export const saveLinkStyle = (style: LinkStyle) => void safely(() => localStorage.setItem(LINK_STYLE_KEY, style))

/** What the meeting has to export. */
export interface ExportSource {
    meetingId: string
    title: string
    createdAt: Date | null
    lines: readonly TranscriptSegment[]
    /** The stored summary (`api_get_summary`'s `data`) and its action items. */
    summary: unknown
    actionItems: readonly ActionItem[]
    /** The user's name, for the microphone's lines. */
    userName?: string
}

// A wikilink cannot hold these, so such a name stays plain.
const NOT_LINKABLE = /[[\]|#\r\n]/

/**
 * A name that is a person's: one voice, not the user's own label and not
 * one nobody named ("Speaker 2", "Guest"). Only these become links and
 * attendees.
 */
export function isLinkableSpeaker(part: string): boolean {
    const name = part.trim()
    return !!name && speakerParts(name).length === 1 && !isUserSpeaker(name) && !isUnnamedSpeaker(name)
}

const wikilink = (name: string) => (NOT_LINKABLE.test(name) ? name : `[[${name}]]`)

function yamlString(value: string): string {
    const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        // eslint-disable-next-line no-control-regex -- control characters are what this escapes
        .replace(/[\x00-\x1f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    return `"${escaped}"`
}

const isoDate = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

function frontmatter(source: ExportSource, linkStyle: LinkStyle): string {
    const attendees = [...new Set(source.lines.flatMap((line) => speakerParts(line.speaker ?? '')))].filter(isLinkableSpeaker)
    const lines = ['---', `title: ${yamlString(source.title)}`, `meeting_id: ${yamlString(source.meetingId)}`]
    if (source.createdAt) lines.push(`date: ${isoDate(source.createdAt)}`)
    if (attendees.length > 0) {
        lines.push('attendees:', ...attendees.map((name) => `  - ${yamlString(linkStyle === 'obsidian' ? wikilink(name) : name)}`))
    }
    lines.push('tags:', '  - protocol', '---')
    return lines.join('\n')
}

/** The summary with its action items, or null when the meeting has none to export. */
export const exportableSummary = (source: Pick<ExportSource, 'summary' | 'actionItems'>) =>
    summaryMarkdown(source.summary, source.actionItems) || null

/**
 * The document for `content` in `format`. Throws when the part asked for is
 * empty, which the sheet prevents by offering only what the meeting has.
 */
export function exportDocument(source: ExportSource, content: ExportContent, format: ExportFormat, linkStyle: LinkStyle): string {
    const sections: [string, string][] = []
    if (content !== 'transcript') {
        const summary = exportableSummary(source)
        if (!summary) throw new Error('There is no summary to export yet')
        // Under the document's "## Summary", its own headings go one level down.
        sections.push(['Summary', summary.replace(/^(#{1,5})(\s)/gm, '#$1$2')])
    }
    if (content !== 'summary') {
        const obsidian = format === 'markdown' && linkStyle === 'obsidian'
        const name = (speaker: string) => speakerParts(speaker)
            .map((part) => (obsidian && isLinkableSpeaker(part) ? wikilink(part) : displaySpeaker(part, source.userName)))
            .join(' + ')
        const transcript = transcriptMarkdown(source.lines, source.userName, name)
        if (!transcript) throw new Error('There is no transcript to export yet')
        sections.push(['Transcript', transcript])
    }
    const document = meetingDocument(source.title, source.createdAt, sections)
    return format === 'markdown' ? `${frontmatter(source, linkStyle)}\n\n${document}` : document
}

/**
 * The file's suggested name: the title, then the part when only one is
 * exported. Letters of any script stay (the old UI kept ASCII only, so a
 * Russian title became `summary`); anything a file system could refuse
 * becomes `_`.
 */
export function exportFileName(title: string, content: ExportContent): string {
    const base = `${title} ${content === 'both' ? '' : content}`.trim()
    return base.replace(/[^\p{L}\p{N}-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'meeting'
}
