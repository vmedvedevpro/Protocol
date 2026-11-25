/**
  * Summaries are stored as markdown, as BlockNote JSON, or (older meetings) as
  * a map of titled sections. These helpers flatten any of them to markdown.
  */

function inlineText(node: unknown): string {
    if (node == null) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(inlineText).join('')
    if (typeof node === 'object') {
        const value = node as {text?: unknown; content?: unknown}
        if (typeof value.text === 'string') return value.text
        if (value.content) return inlineText(value.content)
    }
    return ''
}

export function blocksToMarkdown(blocks: unknown[]): string {
    const out: string[] = []
    const walk = (list: unknown[], depth: number) => {
        for (const raw of list || []) {
            const block = raw as { type?: string; content?: unknown; children?: unknown[]; props?: {level?: number; checked?: boolean} }
            const text = inlineText(block?.content).trim()
            const indent = '  '.repeat(depth)
            switch (block?.type) {
                case 'heading':
                    out.push(`${'#'.repeat(Math.min(6, Math.max(1, block.props?.level ?? 2)))} ${text}`)
                    break
                case 'bulletListItem':
                    out.push(`${indent}- ${text}`)
                    break
                case 'numberedListItem':
                    out.push(`${indent}1. ${text}`)
                    break
                case 'checkListItem':
                    out.push(`${indent}- [${block.props?.checked ? 'x' : ' '}] ${text}`)
                    break
                case 'quote':
                    if (text) out.push(`> ${text}`)
                    break
                case 'table': {
                    const rows = (block.content as { rows?: Array<{cells?: unknown[]}> } | undefined)?.rows
                    if (!Array.isArray(rows) || rows.length === 0) break
                    const cells = rows.map((row) =>
                        (Array.isArray(row?.cells) ? row.cells : []).map((cell) => {
                            const value = cell as {content?: unknown} | unknown[]
                            return inlineText(Array.isArray(value) ? value : value?.content).trim().replace(/\|/g, '\\|')
                        }),
                    )
                    const width = Math.max(1, ...cells.map((row) => row.length))
                    const line = (row: string[]) => `| ${Array.from({length: width}, (_, index) => row[index] ?? '').join(' | ')} |`
                    out.push(line(cells[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...cells.slice(1).map(line))
                    break
                }
                default:
                    if (text) out.push(text)
            }
            if (Array.isArray(block?.children) && block.children.length) walk(block.children, depth + 1)
        }
    }
    walk(blocks, 0)
    return out.join('\n')
}

/**
 * A stored summary once decoded (`parseSummaryData`): Markdown with the
 * editor's blocks, or the older map of titled sections, keyed by section,
 * with `_section_order`.
 */
export type SummaryData = Record<string, unknown> & {
    markdown?: unknown
    summary_json?: unknown
    original_markdown?: unknown
}

interface LegacySection {
    title?: string
    blocks: { content?: unknown }[]
}

const isLegacySection = (value: unknown): value is LegacySection =>
    typeof value === 'object' && value !== null && Array.isArray((value as LegacySection).blocks)

/** The complete, user-visible summary as markdown, whatever format it is stored in. */
export function completeSummaryMarkdown(summary: unknown): string {
    if (!summary) return ''
    if (typeof summary === 'string') return summary
    const value = summary as SummaryData
    if (typeof value.markdown === 'string') return value.markdown
    if (Array.isArray(value.summary_json)) return blocksToMarkdown(value.summary_json)
    const order = Array.isArray(value._section_order) ? (value._section_order as string[]) : []
    const keys = [...new Set([...order, ...Object.keys(value)])]
    return keys
        .flatMap((key) => {
            if (key === 'english_cache' || key === 'original_markdown') return []
            const section = value[key]
            if (!isLegacySection(section)) return []
            return [`## ${section.title || key}\n\n${section.blocks.map((block) => inlineText(block.content)).join('\n\n')}`]
        })
        .join('\n\n')
}

/** api_get_summary may return its data double-encoded. */
export function parseSummaryData(data: unknown): SummaryData | null {
    if (!data) return null
    if (typeof data === 'string') {
        try {
            const parsed: unknown = JSON.parse(data)
            return parsed && typeof parsed === 'object' ? (parsed as SummaryData) : {markdown: data}
        } catch {
            return {markdown: data}
        }
    }
    return typeof data === 'object' ? (data as SummaryData) : null
}

/** The editor's blocks of a summary edited in the app, when it has them. */
export function summaryBlocks(data: SummaryData | null): unknown[] | null {
    return Array.isArray(data?.summary_json) ? data.summary_json : null
}

/** One editor's share of a summary: its blocks when the summary has them, and its Markdown. */
export interface SummaryPart {
    blocks: unknown[] | null
    markdown: string
}

// The section the action items go before: the design orders Decisions,
// Action items, Open questions.
const AFTER_ACTION_ITEMS = /^open questions\b/i
const AFTER_ACTION_ITEMS_LINE = /^#{1,6}[ \t]+open questions\b/im

const isSectionAfterActionItems = (raw: unknown) => {
    const block = raw as { type?: string; content?: unknown }
    return block?.type === 'heading' && AFTER_ACTION_ITEMS.test(inlineText(block.content).trim())
}

/**
 * Splits a summary where its action items belong, before its "Open
 * questions" section, so the rows sit between Decisions and Open questions.
 * Without that section (or when it comes first) the second part is empty.
 */
export function splitSummaryAtActionItems(data: SummaryData | null): [SummaryPart, SummaryPart] {
    const blocks = summaryBlocks(data)
    if (blocks) {
        const at = blocks.findIndex(isSectionAfterActionItems)
        if (at <= 0) return [{blocks, markdown: completeSummaryMarkdown(data)}, {blocks: null, markdown: ''}]
        const head = blocks.slice(0, at)
        const tail = blocks.slice(at)
        return [{blocks: head, markdown: blocksToMarkdown(head)}, {blocks: tail, markdown: blocksToMarkdown(tail)}]
    }
    const markdown = completeSummaryMarkdown(data)
    const match = AFTER_ACTION_ITEMS_LINE.exec(markdown)
    if (!match || match.index === 0) return [{blocks: null, markdown}, {blocks: null, markdown: ''}]
    return [{blocks: null, markdown: markdown.slice(0, match.index).trimEnd()}, {blocks: null, markdown: markdown.slice(match.index)}]
}
