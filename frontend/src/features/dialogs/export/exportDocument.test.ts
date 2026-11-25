import {describe, expect, it} from 'vitest'
import type {TranscriptSegment} from '@/api/meetings'
import {exportDocument, exportFileName, type ExportSource} from './exportDocument'
import {exportJson, markdownToPlainText, renderFile} from './formats'

const line = (text: string, start: number, speaker?: string): TranscriptSegment =>
    ({id: text, text, timestamp: '', audio_start_time: start, speaker})

const source = (extra: Partial<ExportSource> = {}): ExportSource => ({
    meetingId: 'meeting-1',
    title: 'Acme "pilot" review',
    createdAt: new Date(2026, 10, 21, 9, 30),
    lines: [
        line('Welcome', 1, 'You'),
        line('Thanks', 5, 'Priya Shah'),
        line('Both at once', 9, 'Priya Shah + Speaker 2'),
        line('Hello', 14, 'Speaker 2'),
    ],
    summary: {markdown: '## Decisions\n\n- Ship the pilot'},
    actionItems: [],
    userName: 'Jay',
    ...extra,
})

describe('exportDocument', () => {
    it('writes Markdown with frontmatter and wikilinks to named speakers only', () => {
        const markdown = exportDocument(source(), 'both', 'markdown', 'obsidian')
        expect(markdown).toMatch(/^---\ntitle: "Acme \\"pilot\\" review"\nmeeting_id: "meeting-1"\ndate: 2026-11-21\nattendees:\n {2}- "\[\[Priya Shah]]"\ntags:\n {2}- protocol\n---\n\n# Acme "pilot" review\n/)
        // The summary's own headings go one level under its section.
        expect(markdown).toContain('## Summary\n\n### Decisions\n\n- Ship the pilot')
        expect(markdown).toContain('[00:01] **Jay (You):** Welcome')
        expect(markdown).toContain('[00:05] **[[Priya Shah]]:** Thanks')
        expect(markdown).toContain('[00:09] **[[Priya Shah]] + Speaker 2:** Both at once')
        expect(markdown).toContain('[00:14] **Speaker 2:** Hello')
    })

    it('keeps plain names in generic Markdown and in every other format', () => {
        expect(exportDocument(source(), 'transcript', 'markdown', 'generic')).toContain('  - "Priya Shah"')
        const text = exportDocument(source(), 'transcript', 'txt', 'obsidian')
        expect(text).not.toContain('[[')
        expect(text).not.toContain('meeting_id')
        expect(text).not.toContain('## Summary')
    })

    it('refuses a part the meeting does not have', () => {
        expect(() => exportDocument(source({summary: null}), 'both', 'pdf', 'generic')).toThrow('There is no summary to export yet')
        expect(() => exportDocument(source({lines: []}), 'transcript', 'pdf', 'generic')).toThrow('There is no transcript to export yet')
    })

    it('names the file after the title in any script', () => {
        expect(exportFileName('Планёрка: итоги/план', 'summary')).toBe('Планёрка_итоги_план_summary')
        expect(exportFileName('Acme review', 'both')).toBe('Acme_review')
        expect(exportFileName('???', 'both')).toBe('meeting')
    })
})

describe('formats', () => {
    it('writes plain text and JSON from the Markdown', () => {
        expect(markdownToPlainText('# Title\n\n**Bold** and `code`\n- item')).toBe('Title\n\nBold and code\n• item')
        expect(JSON.parse(exportJson('# T', 'T', new Date('2026-11-25T10:00:00Z')))).toEqual({
            app: 'Protocol', title: 'T', exportedAt: '2026-11-25T10:00:00.000Z', markdown: '# T', text: 'T',
        })
    })

    it('keeps Cyrillic in a PDF: Geist is embedded and maps the glyphs back to the letters', async () => {
        const bytes = await renderFile('pdf', '# Встреча\n\nПривет, мир', 'Встреча')
        const pdf = new TextDecoder('latin1').decode(bytes)
        expect(pdf).toContain('/BaseFont /Geist')
        expect(pdf).toContain('/FontFile2')
        // The ToUnicode map gives each glyph its letter: П, и, р, м.
        for (const letter of ['041f', '0438', '0440', '043c']) expect(pdf.toLowerCase()).toContain(`<${letter}>`)
    })

    it('renders a PDF and a Word file', async () => {
        const header = (bytes: Uint8Array, length: number) => new TextDecoder().decode(bytes.slice(0, length))
        expect(header(await renderFile('pdf', '# Title\n\n- **Bold** item\n\n---\n\nText', 'Title'), 5)).toBe('%PDF-')
        // A .docx is a ZIP.
        expect(header(await renderFile('docx', '# Title\n\n- **Bold** item', 'Title'), 2)).toBe('PK')
    })
})
