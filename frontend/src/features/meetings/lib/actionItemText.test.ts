import {assert, describe, test} from 'vitest'
import {
    extractActionItems,
    fingerprint,
    isActionHeading,
    locateInTranscript,
    parseActionLine,
} from './actionItemText'

describe('isActionHeading', () => {
    test('recognises common action headings', () => {
        for (const heading of [
            'Action Items',
            'Action items:',
            '✅ Action Items',
            '3. Next Steps',
            '**Action Items**',
            'Action Items (Owner, Due)',
            'Follow-ups',
            'To-dos',
            'Action items & owners',
        ]) {
            assert.ok(isActionHeading(heading), heading)
        }
    })

    test('leaves other sections alone', () => {
        for (const heading of ['Summary', 'Decisions and actions taken last quarter', 'Key Decisions', 'Discussion', 'Risks']) {
            assert.strictEqual(isActionHeading(heading), false, heading)
        }
    })
})

describe('parseActionLine', () => {
    test('reads "Owner: task" and a trailing due date', () => {
        assert.deepEqual(parseActionLine('- Priya Shah: send the draft support terms by Friday'), {
            text: 'send the draft support terms',
            ownerLabel: 'Priya Shah',
            dueText: 'Friday',
        })
    })

    test('reads @mentions, brackets, and owner asides', () => {
        assert.strictEqual(parseActionLine('- @Marcus scope the audio player').ownerLabel, 'Marcus')
        assert.strictEqual(parseActionLine('- [Elena] share the new flow').ownerLabel, 'Elena')
        const aside = parseActionLine('- Update the rollout doc (owner: Tom Becker)')
        assert.strictEqual(aside.ownerLabel, 'Tom Becker')
        assert.strictEqual(aside.text, 'Update the rollout doc')
    })

    test('keeps plain tasks, strips checkboxes and bold', () => {
        assert.deepEqual(parseActionLine('- [ ] **Book** the room'), {text: 'Book the room', ownerLabel: null, dueText: null})
    })

    test('does not mistake a label for an owner', () => {
        assert.strictEqual(parseActionLine('- Note: the pilot needs 20 seats').ownerLabel, null)
    })

    test('normalises "you"', () => {
        assert.strictEqual(parseActionLine('- you: follow up with procurement').ownerLabel, 'You')
    })
})

describe('extractActionItems', () => {
    const summary = [
        '## Summary',
        'The pilot starts next month.',
        '',
        '## Action Items',
        '- Priya Shah: prepare a local-only config by Friday',
        '- You: write the retention statement',
        '  - include the recordings folder',
        '',
        '## Open questions',
        '- Who signs the support agreement?',
    ].join('\n')

    test('pulls items and removes only the action section', () => {
        const result = extractActionItems(summary)
        assert.strictEqual(result.hadActionSection, true)
        assert.strictEqual(result.drafts.length, 2)
        assert.strictEqual(result.drafts[0].ownerLabel, 'Priya Shah')
        assert.strictEqual(result.drafts[0].dueText, 'Friday')
        assert.strictEqual(result.drafts[1].text, 'write the retention statement; include the recordings folder')
        assert.strictEqual(
            result.remainingMarkdown,
            '## Summary\nThe pilot starts next month.\n\n## Open questions\n- Who signs the support agreement?',
        )
    })

    test('parses owner/task/due tables and skips header rows', () => {
        const table = [
            '### Action items',
            '| Owner | Task | Due |',
            '| --- | --- | --- |',
            '| Priya Shah | Send draft terms | Today |',
            '| **Tom** | Confirm seat count | TBD |',
        ].join('\n')
        const result = extractActionItems(table)
        assert.deepEqual(result.drafts, [
            {text: 'Send draft terms', ownerLabel: 'Priya Shah', dueText: 'Today'},
            {text: 'Confirm seat count', ownerLabel: 'Tom', dueText: null},
        ])
        assert.strictEqual(result.remainingMarkdown, '')
    })

    test('a "none" section is removed and yields no items', () => {
        const result = extractActionItems('## Summary\nShort sync.\n\n## Action Items\nNo action items were identified.')
        assert.strictEqual(result.hadActionSection, true)
        assert.strictEqual(result.drafts.length, 0)
        assert.strictEqual(result.remainingMarkdown, '## Summary\nShort sync.')
    })

    test('summaries without a recognisable section are left untouched', () => {
        const other = '## Resumen\n- Priya enviará los términos'
        const result = extractActionItems(other)
        assert.strictEqual(result.hadActionSection, false)
        assert.strictEqual(result.remainingMarkdown, other)
        assert.strictEqual(result.drafts.length, 0)
    })

    test('an empty action heading is kept as-is rather than guessed at', () => {
        const odd = '## Action Items\n\n## Summary\nText'
        const result = extractActionItems(odd)
        assert.strictEqual(result.hadActionSection, false)
        assert.strictEqual(result.remainingMarkdown, odd)
    })

    test('bold pseudo-headings work and stop at the next heading', () => {
        const bold = '**Next steps:**\n1. Marcus - estimate the player work\n\n## Decisions\n- Banner, not toast'
        const result = extractActionItems(bold)
        assert.strictEqual(result.drafts[0].ownerLabel, 'Marcus')
        assert.strictEqual(result.remainingMarkdown, '## Decisions\n- Banner, not toast')
    })

    test('duplicate items across sections collapse', () => {
        const doubled = '## Action items\n- Send terms\n\n## Next steps\n- send terms'
        assert.strictEqual(extractActionItems(doubled).drafts.length, 1)
    })

    test('extraction is stable once the section is gone', () => {
        const once = extractActionItems(summary).remainingMarkdown
        const twice = extractActionItems(once)
        assert.strictEqual(twice.hadActionSection, false)
        assert.strictEqual(twice.remainingMarkdown, once)
    })
})

describe('fingerprint and locateInTranscript', () => {
    test('fingerprints are stable and content-sensitive', () => {
        assert.strictEqual(fingerprint('abc'), fingerprint('abc'))
        assert.notStrictEqual(fingerprint('abc'), fingerprint('abd'))
    })

    test('finds the line where an item was discussed', () => {
        const segments = [
            {id: 't1', timestamp: 4, text: 'Thanks for making time today.'},
            {id: 't2', timestamp: 31, text: 'We can ship a config that only shows local models by Friday.'},
            {id: 't3', timestamp: 60, text: 'The support agreement is the last question.'},
        ]
        assert.deepEqual(locateInTranscript('prepare a config that only shows local models', segments), {
            audioTime: 31,
            transcriptId: 't2',
        })
        assert.strictEqual(locateInTranscript('order new laptops for the design team', segments), null)
    })
})
