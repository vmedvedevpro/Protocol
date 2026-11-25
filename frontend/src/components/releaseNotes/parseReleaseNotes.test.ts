import {describe, expect, it} from 'vitest'
import {createMockUpdateRelease} from '@/mocks/updater'
import {parseReleaseNotes} from './parseReleaseNotes'

describe('parseReleaseNotes', () => {
    it('reads the changelog’s paragraphs, headings and wrapped list items', () => {
        const blocks = parseReleaseNotes(createMockUpdateRelease().notes ?? '')

        expect(blocks.map(({kind}) => kind)).toEqual(['paragraph', 'heading', 'list', 'heading', 'list'])
        expect(blocks[2]).toEqual({
            kind: 'list',
            items: [
                '**A compact window** ([#123](https://github.com/vmedvedevpro/Protocol/issues/123)). Protocol opens at 460 × 700 and stays beside your call. Pin it to keep it on top.',
                '**Simple settings.** Your name, the theme, the microphone and summaries on one page; the rest is behind **Advanced**.',
            ],
        })
    })

    it('ends a list at an unindented line and keeps HTML as text', () => {
        expect(parseReleaseNotes('* one\n<b>two</b>\r\n\nthree')).toEqual([
            {kind: 'list', items: ['one']},
            {kind: 'paragraph', text: '<b>two</b>'},
            {kind: 'paragraph', text: 'three'},
        ])
    })
})
