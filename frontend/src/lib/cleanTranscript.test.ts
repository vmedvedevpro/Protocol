import {describe, expect, it} from 'vitest'
import {cleanTranscriptText} from './cleanTranscript'

describe('cleanTranscriptText', () => {
    it('drops fillers and words said twice, and keeps a doubled no', () => {
        expect(cleanTranscriptText('um, so the the export uh works , right?')).toBe('So the export works, right?')
        expect(cleanTranscriptText('No no, that is very very good')).toBe('No no, that is very very good')
    })

    it('leaves words that only start like a filler', () => {
        expect(cleanTranscriptText('Umbrella errands were erm done')).toBe('Umbrella errands were done')
    })
})
