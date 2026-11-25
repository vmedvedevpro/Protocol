import {assert, describe, test} from 'vitest'
import {blocksToMarkdown, completeSummaryMarkdown, parseSummaryData, splitSummaryAtActionItems} from './summaryMarkdown'

const text = (value: string) => [{ type: 'text', text: value, styles: {} }]

describe('blocksToMarkdown', () => {
    test('writes headings, lists and quotes', () => {
        const markdown = blocksToMarkdown([
            { type: 'heading', props: {level: 2}, content: text('Summary') },
            {type: 'paragraph', content: text('We agreed on the pilot.')},
            { type: 'bulletListItem', content: text('First'), children: [{type: 'bulletListItem', content: text('Nested')}] },
            {type: 'quote', content: text('Ship it')},
        ])
        assert.strictEqual(markdown, '## Summary\nWe agreed on the pilot.\n- First\n  - Nested\n> Ship it')
    })

    test('keeps tables, so action tables stored as blocks can be read', () => {
        const blocks = [
            { type: 'heading', props: {level: 2}, content: text('Action items') },
            {
                type: 'table',
                content: {
                    type: 'tableContent',
                    rows: [
                        { cells: [{type: 'tableCell', content: text('Owner')}, {type: 'tableCell', content: text('Task')}] },
                        { cells: [{type: 'tableCell', content: text('Priya Shah')}, {type: 'tableCell', content: text('Send the terms')}] },
                        // Older BlockNote versions store cells as bare inline content.
                        {cells: [text('You'), text('Book a | check-in')]},
                    ],
                },
            },
        ]
        const markdown = blocksToMarkdown(blocks)
        assert.strictEqual(
            markdown,
            '## Action items\n| Owner | Task |\n| --- | --- |\n| Priya Shah | Send the terms |\n| You | Book a \\| check-in |',
        )
    })
})

describe('completeSummaryMarkdown', () => {
    test('prefers stored markdown over blocks', () => {
        assert.strictEqual(completeSummaryMarkdown({ markdown: '# A', summary_json: [{type: 'paragraph', content: text('B')}] }), '# A')
    })

    test('flattens legacy titled sections in order', () => {
        const markdown = completeSummaryMarkdown({
            _section_order: ['decisions', 'summary'],
            summary: { title: 'Summary', blocks: [{content: 'Short'}] },
            decisions: { title: 'Decisions', blocks: [{content: 'Go'}] },
        })
        assert.strictEqual(markdown, '## Decisions\n\nGo\n\n## Summary\n\nShort')
    })
})

describe('parseSummaryData', () => {
    test('decodes double-encoded JSON and wraps plain text', () => {
        assert.deepEqual(parseSummaryData('{"markdown":"# Hi"}'), {markdown: '# Hi'})
        assert.deepEqual(parseSummaryData('Just text'), {markdown: 'Just text'})
        assert.strictEqual(parseSummaryData(null), null)
    })
})

describe('splitSummaryAtActionItems', () => {
    test('splits Markdown before Open questions', () => {
        const [head, tail] = splitSummaryAtActionItems({markdown: '## Decisions\n\n- Ship it\n\n## Open questions\n\n- Who signs?'})
        assert.deepEqual(head, {blocks: null, markdown: '## Decisions\n\n- Ship it'})
        assert.deepEqual(tail, {blocks: null, markdown: '## Open questions\n\n- Who signs?'})
    })

    test('splits blocks at the Open questions heading', () => {
        const blocks = [
            {type: 'heading', props: {level: 2}, content: text('Decisions')},
            {type: 'bulletListItem', content: text('Ship it')},
            {type: 'heading', props: {level: 2}, content: text('Open questions')},
            {type: 'bulletListItem', content: text('Who signs?')},
        ]
        const [head, tail] = splitSummaryAtActionItems({summary_json: blocks, markdown: 'ignored'})
        assert.deepEqual(head.blocks, blocks.slice(0, 2))
        assert.deepEqual(tail.blocks, blocks.slice(2))
        assert.strictEqual(tail.markdown, '## Open questions\n- Who signs?')
    })

    test('keeps a summary without Open questions whole', () => {
        const [head, tail] = splitSummaryAtActionItems({markdown: '## Summary\n\nDone.'})
        assert.strictEqual(head.markdown, '## Summary\n\nDone.')
        assert.deepEqual(tail, {blocks: null, markdown: ''})
    })
})
