import {describe, expect, it} from 'vitest'
import type {TranscriptSegment} from '@/api/meetings'
import {countSpeakers} from './identifySpeakers'

const said = (speaker?: string): TranscriptSegment => ({id: String(speaker), text: 'text', timestamp: '', speaker})

describe('countSpeakers', () => {
    it('counts each voice once, overlaps split, unlabelled lines left out', () => {
        expect(countSpeakers([said('You'), said('Speaker 1'), said('Speaker 1 + Speaker 2'), said(), said('  ')])).toBe(3)
    })

    it('counts nothing for a transcript no one labelled', () => {
        expect(countSpeakers([said(), said()])).toBe(0)
    })
})
