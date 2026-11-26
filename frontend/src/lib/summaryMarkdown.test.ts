import {assert, describe, test} from 'vitest'
import {blocksToMarkdown, completeSummaryMarkdown, markdownSnippetText, parseSummaryData} from './summaryMarkdown'

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

describe('markdownSnippetText', () => {
    test('shows a summary snippet without its Markdown', () => {
        assert.equal(
            markdownSnippetText('## Summary\nThe team **agreed** on _retention_ and `30 days`.\n- Ship the [policy](https://x.y) draft\n1. Ask legal\n> Quoted'),
            'Summary The team agreed on retention and 30 days. Ship the policy draft Ask legal Quoted',
        )
    })

    test('reads a table as its cells', () => {
        assert.equal(markdownSnippetText('...Shah | Send terms | Today |\n|---|---|---|\n| You | Write it | Next week |'), '...Shah, Send terms, Today You, Write it, Next week')
    })

    test('leaves a mark the cut left alone, and plain words with underscores', () => {
        assert.equal(markdownSnippetText('...was **agreed'), '...was **agreed')
        assert.equal(markdownSnippetText('the snake_case name'), 'the snake_case name')
    })
})
