import type {Block} from '@blocknote/core'
import {describe, expect, it, vi} from 'vitest'
import {blocksToMarkdownSafely} from './blocknote-markdown'

// Ported from the old app's tests/lib/blocknote-markdown.test.ts (bun:test).

describe('blocksToMarkdownSafely', () => {
    it('returns markdown when conversion succeeds', () => {
        const editor = {blocksToMarkdownLossy: vi.fn(() => '# Summary')}

        const result = blocksToMarkdownSafely(editor, [], {source: 'test-success'})

        expect(result).toEqual({markdown: '# Summary', ok: true})
        expect(editor.blocksToMarkdownLossy).toHaveBeenCalledTimes(1)
    })

    it('returns fallback markdown when conversion throws', () => {
        const error = new Error('conversion failed')
        const editor = {
            blocksToMarkdownLossy: vi.fn((): string => {
                throw error
            }),
        }
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

        const result = blocksToMarkdownSafely(editor, [{id: 'block-1'}] as Block[], {
            source: 'test-fallback',
            fallbackMarkdown: 'existing markdown',
        })

        expect(result).toEqual({markdown: 'existing markdown', ok: false})
        expect(consoleError).toHaveBeenCalledTimes(1)
        expect(consoleError).toHaveBeenCalledWith('Failed to convert BlockNote blocks to markdown', {
            source: 'test-fallback',
            blocksCount: 1,
            error,
        })
    })

    it('omits markdown when conversion throws without fallback', () => {
        const editor = {
            blocksToMarkdownLossy: vi.fn((): string => {
                throw new Error('conversion failed')
            }),
        }
        vi.spyOn(console, 'error').mockImplementation(() => {})

        const result = blocksToMarkdownSafely(editor, [], {source: 'test-empty-fallback'})

        expect(result).toEqual({markdown: undefined, ok: false})
    })
})
