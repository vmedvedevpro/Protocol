import {describe, expect, it} from 'vitest'
import {
    activeTurnIndex,
    displaySpeaker,
    formatClock,
    isUnnamedSpeaker,
    isUserSpeaker,
    joinTurns,
    lineFromSegment,
    type TranscriptLine,
} from './turns'

const line = (id: string, speaker: string | null, start: number | null, end: number | null, text = id): TranscriptLine =>
    ({id, text, start, end, speaker})

describe('transcript turns', () => {
    it('joins lines of one voice less than 2.5 s apart', () => {
        const turns = joinTurns([
            line('a', 'You', 0, 2, 'Hello'),
            line('b', 'You', 3, 4, 'there.'),
            line('c', 'Speaker 2', 4.5, 6, 'Hi.'),
            line('d', 'Speaker 2', 9, 10, 'Later.'),
        ])

        expect(turns.map((turn) => [turn.text, turn.lineIds])).toEqual([
            ['Hello there.', ['a', 'b']],
            ['Hi.', ['c']],
            ['Later.', ['d']],
        ])
        expect(turns[0]).toMatchObject({start: 0, end: 4})
    })

    it('treats every form of the user\'s label as one voice, and never joins lines without times', () => {
        const turns = joinTurns([
            line('a', 'You', 0, 1),
            line('b', 'Jay (You)', 1.5, 2),
            line('c', 'You', null, null),
            line('d', 'You', null, null),
        ])

        expect(turns.map((turn) => turn.lineIds)).toEqual([['a', 'b'], ['c'], ['d']])
    })

    it('finds the turn being played: the last one started, kept through the pause after it', () => {
        const turns = joinTurns([line('a', 'You', 4, 8), line('b', 'Speaker 2', 20, 25), line('c', 'You', 40, 45)])

        expect(activeTurnIndex(turns, 0)).toBe(-1)
        expect(activeTurnIndex(turns, 4)).toBe(0)
        expect(activeTurnIndex(turns, 15)).toBe(0)
        expect(activeTurnIndex(turns, 19.98)).toBe(1)
        expect(activeTurnIndex(turns, 400)).toBe(2)
    })

    it('names voices the way the transcript shows them', () => {
        expect(isUserSpeaker('You')).toBe(true)
        expect(isUserSpeaker('You + Speaker 2')).toBe(false)
        expect(isUnnamedSpeaker('Speaker 3')).toBe(true)
        expect(isUnnamedSpeaker('Guest')).toBe(true)
        expect(isUnnamedSpeaker('Priya Shah')).toBe(false)
        expect(displaySpeaker('You', 'Jay')).toBe('Jay (You)')
        expect(displaySpeaker('You + Speaker 2')).toBe('You + Speaker 2')
    })

    it('formats times past an hour with the hour', () => {
        expect(formatClock(393)).toBe('06:33')
        expect(formatClock(3725.9)).toBe('1:02:05')
    })

    it('maps a saved line, keeping a missing time as null', () => {
        expect(lineFromSegment({id: 'x', text: 'Hi', timestamp: '09:30:00', speaker: 'You'}))
            .toEqual({id: 'x', text: 'Hi', start: null, end: null, speaker: 'You'})
    })
})
