/**
 * Renders an export's Markdown into its file and saves it where the user
 * chooses, as the old UI did (`162e8be:frontend/src/lib/exportSummary.ts`):
 * the WebView makes the bytes, the system's save dialog picks the place and
 * grants the fs plugin that one path, and `plugin:fs|write_file` writes it.
 * A browser-style download could not honour the folder in a Tauri WebView.
 * jsPDF and docx load only when a PDF or a Word file is made.
 */
import {writeFile} from '@tauri-apps/plugin-fs'
import {command} from '@/api/core'
import type {ExportFormat} from './exportDocument'

export type FileFormat = Exclude<ExportFormat, 'clipboard'>

const FILES: Record<FileFormat, { extension: string, name: string }> = {
    pdf: {extension: 'pdf', name: 'PDF'},
    docx: {extension: 'docx', name: 'Word document'},
    txt: {extension: 'txt', name: 'Text'},
    markdown: {extension: 'md', name: 'Markdown'},
    json: {extension: 'json', name: 'JSON'},
}

/** The Markdown as plain text: no heading marks, bold or code, bullets as •. */
export function markdownToPlainText(markdown: string): string {
    return markdown
        .replace(/\r\n/g, '\n')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^\s*[-*]\s+/gm, '• ')
        .replace(/^\s*---\s*$/gm, '----------')
        .trim()
}

/** The old UI's JSON: the rendered document as Markdown and as plain text. */
export function exportJson(markdown: string, title: string, now = new Date()): string {
    return JSON.stringify({app: 'Protocol', title, exportedAt: now.toISOString(), markdown, text: markdownToPlainText(markdown)}, null, 2)
}

/** A Markdown line as runs of plain and **bold** text. */
function inlineRuns(line: string): { text: string, bold: boolean }[] {
    const runs = line.split(/(\*\*[^*]+\*\*)/g)
        .filter(Boolean)
        .map((part) => (part.startsWith('**') && part.endsWith('**')
            ? {text: part.slice(2, -2), bold: true}
            : {text: part.replace(/\*\*/g, ''), bold: false}))
    return runs.length > 0 ? runs : [{text: line, bold: false}]
}

const HEADING = /^(#{1,4})\s+(.*)$/
const BULLET = /^\s*[-*]\s+(.*)$/

async function docxBytes(markdown: string): Promise<Uint8Array> {
    const {Document, HeadingLevel, Packer, Paragraph, TextRun} = await import('docx')
    const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4]
    const runs = (line: string) => inlineRuns(line).map((run) => new TextRun({text: run.text, bold: run.bold}))
    const paragraphs = markdown.replace(/\r\n/g, '\n').split('\n').map((raw) => {
        const line = raw.trimEnd()
        if (line.trim() === '' || line.trim() === '---') return new Paragraph({children: []})
        const heading = HEADING.exec(line)
        if (heading) return new Paragraph({heading: levels[heading[1].length - 1], children: [new TextRun({text: heading[2].replace(/\*\*/g, '')})]})
        const bullet = BULLET.exec(line)
        if (bullet) return new Paragraph({bullet: {level: 0}, children: runs(bullet[1])})
        return new Paragraph({children: runs(line)})
    })
    const blob = await Packer.toBlob(new Document({sections: [{children: paragraphs}]}))
    return new Uint8Array(await blob.arrayBuffer())
}

async function pdfBytes(markdown: string): Promise<Uint8Array> {
    const {jsPDF} = await import('jspdf')
    const doc = new jsPDF({unit: 'pt', format: 'a4'})
    // The old export's A4 page, in points.
    const marginX = 48
    const marginY = 56
    const width = doc.internal.pageSize.getWidth()
    const height = doc.internal.pageSize.getHeight()
    let y = marginY

    const room = (lineHeight: number) => {
        if (y + lineHeight <= height - marginY) return
        doc.addPage()
        y = marginY
    }
    const write = (text: string, size: number, bold: boolean, gapAfter: number, indent = 0) => {
        doc.setFont('helvetica', bold ? 'bold' : 'normal')
        doc.setFontSize(size)
        const lineHeight = size * 1.25
        for (const wrapped of doc.splitTextToSize(text, width - marginX * 2 - indent) as string[]) {
            room(lineHeight)
            doc.text(wrapped, marginX + indent, y)
            y += lineHeight
        }
        y += gapAfter
    }

    for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
        const line = raw.trimEnd()
        if (line.trim() === '') {
            y += 6
            continue
        }
        if (line.trim() === '---') {
            room(10)
            doc.setDrawColor(200)
            doc.line(marginX, y, width - marginX, y)
            y += 12
            continue
        }
        const heading = HEADING.exec(line)
        if (heading) {
            write(heading[2].replace(/\*\*/g, ''), [20, 16, 13, 12][heading[1].length - 1], true, 6)
            continue
        }
        const bullet = BULLET.exec(line)
        if (bullet) write(`•  ${bullet[1].replace(/\*\*/g, '')}`, 11, false, 2, 10)
        else write(line.replace(/\*\*/g, ''), 11, false, 4)
    }
    return new Uint8Array(doc.output('arraybuffer'))
}

/** The file's bytes; `title` names the JSON's document. */
export async function renderFile(format: FileFormat, markdown: string, title: string): Promise<Uint8Array> {
    if (format === 'pdf') return pdfBytes(markdown)
    if (format === 'docx') return docxBytes(markdown)
    const text = format === 'txt' ? markdownToPlainText(markdown) : format === 'json' ? exportJson(markdown, title) : markdown
    return new TextEncoder().encode(text)
}

/**
 * Asks where to save, through the dialog plugin's save dialog
 * (`dialog:allow-save`); null when the user cancels. A GTK dialog returns
 * the name as typed, without the filter's extension, and asked about
 * replacing only that name, so adding the extension here could replace a
 * file unasked: the dialog opens once more on the name with it and runs its
 * own overwrite prompt, as the crash report's ZIP does
 * (src/api/crashReport.ts). A name still without it is written as given:
 * that is the name the prompt asked about.
 */
export async function chooseExportPath(format: FileFormat, baseName: string): Promise<string | null> {
    const {extension, name} = FILES[format]
    const ask = (defaultPath: string) => command<string | null>('plugin:dialog|save', {
        options: {defaultPath, filters: [{name, extensions: [extension]}]},
    })
    const chosen = await ask(`${baseName}.${extension}`)
    if (!chosen || chosen.toLowerCase().endsWith(`.${extension}`)) return chosen
    return ask(`${chosen}.${extension}`)
}

/**
 * Renders and saves the export; false when the user cancelled the dialog.
 * The path is chosen first, so a cancelled dialog renders nothing.
 */
export async function saveExport(format: FileFormat, markdown: string, title: string, baseName: string): Promise<boolean> {
    const path = await chooseExportPath(format, baseName)
    if (!path) return false
    await writeFile(path, await renderFile(format, markdown, title))
    return true
}
