import type {Block} from '@blocknote/core'

/**
 * What the conversion needs from a BlockNote editor. The export is
 * synchronous in BlockNote 0.57; the old app's 0.36 returned a promise.
 */
export interface MarkdownCapableEditor {
    blocksToMarkdownLossy: (blocks: Block[]) => string
}

export interface MarkdownConversionOptions {
    /** Names the caller in the error log. */
    source: string
    /** Returned when the conversion throws, such as the last good Markdown. */
    fallbackMarkdown?: string
}

export interface MarkdownConversionResult {
    markdown?: string
    ok: boolean
}

/**
 * The Markdown of `blocks`, or `fallbackMarkdown` when BlockNote's exporter
 * throws. The blocks stay the exact copy of the notes; the Markdown is the
 * lossy one that search, export and AI read, so a failed conversion keeps
 * the last good Markdown instead of saving an empty one next to correct
 * blocks.
 */
export function blocksToMarkdownSafely(
    editor: MarkdownCapableEditor,
    blocks: Block[],
    options: MarkdownConversionOptions,
): MarkdownConversionResult {
    try {
        return {markdown: editor.blocksToMarkdownLossy(blocks), ok: true}
    } catch (error) {
        console.error('Failed to convert BlockNote blocks to markdown', {
            source: options.source,
            blocksCount: blocks.length,
            error,
        })
        return {markdown: options.fallbackMarkdown, ok: false}
    }
}
