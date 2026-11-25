import {describe, expect, it} from 'vitest'
import {spyOnIpc} from '@/test/ipc'
import {LIVE_NOTES_BUDGET, LIVE_TRANSCRIPT_BUDGET, summarizeSoFar} from './assistant'
import {type LiveLine, transcriptText} from './transcript'

const line = (sequenceId: number, text: string, speaker = ''): LiveLine => ({
    sequenceId,
    text,
    speaker,
    source: 'mic',
    start: sequenceId,
    end: sequenceId + 1,
    timestamp: '',
    confidence: 1,
})

describe('transcriptText', () => {
    it('writes one line a turn, with its speaker when it has one', () => {
        expect(transcriptText([line(1, ' Hello ', 'You'), line(2, 'Hi there')])).toBe('You: Hello\nHi there')
    })

    it('keeps the newest lines that fit the budget, in order', () => {
        const lines = [line(1, 'first', 'You'), line(2, 'second', 'You'), line(3, 'third', 'You')]
        // "You: second\n" and "You: third\n" are 12 and 11 characters; "You: first" no longer fits.
        expect(transcriptText(lines, 23)).toBe('You: second\nYou: third')
        expect(transcriptText(lines, 5)).toBe('')
    })
})

describe('summarizeSoFar', () => {
    it('sends the newest lines and the start of the notes within the old UI’s budgets', async () => {
        const invoke = spyOnIpc()
        // About three times the transcript budget.
        const lines = Array.from({length: 600}, (_, at) => line(at, `Line ${at} of a long meeting about the roadmap`, 'Speaker 2'))
        const notes = 'n'.repeat(LIVE_NOTES_BUDGET + 500)

        await summarizeSoFar(lines, notes)

        const [, args] = invoke.mock.calls.find(([command]) => command === 'ask_live_assistant')!
        const {transcriptContext, persona} = args as { transcriptContext: string, persona: string }
        expect(transcriptContext.length).toBeLessThanOrEqual(LIVE_TRANSCRIPT_BUDGET)
        expect(transcriptContext.endsWith('Line 599 of a long meeting about the roadmap')).toBe(true)
        expect(transcriptContext).not.toContain('Line 0 of')
        expect(persona).toContain('n'.repeat(LIVE_NOTES_BUDGET))
        expect(persona).not.toContain('n'.repeat(LIVE_NOTES_BUDGET + 1))
    })
})
