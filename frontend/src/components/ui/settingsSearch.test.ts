import {describe, expect, it} from 'vitest'
import {matchesTerms, searchTerms} from './settingsSearch'

const matches = (query: string, ...parts: (string | undefined)[]) => matchesTerms(searchTerms(query), ...parts)

describe('settings search', () => {
    it('matches whole words and the start of words, in any case', () => {
        expect(matches('model', 'Model updates', 'Speech and summary model files')).toBe(true)
        expect(matches('model', 'Credits', 'Models and open-source libraries')).toBe(true)
        expect(matches('SUMM', 'Summary model')).toBe(true)
        expect(matches('open source', 'Models and open-source libraries')).toBe(true)
        expect(matches('микро', 'Микрофон')).toBe(true)
    })

    it('does not match inside a word (#121: "model" listed sections without it)', () => {
        expect(matches('odel', 'Model updates')).toBe(false)
        expect(matches('ear', 'Appearance', 'Every window, including the recording bar')).toBe(false)
        expect(matches('model', 'Theme', 'Every window, including the recording bar')).toBe(false)
    })

    it('needs every word of the query', () => {
        expect(matches('summary model', 'Summary model', 'Built-in')).toBe(true)
        expect(matches('summary theme', 'Summary model')).toBe(false)
    })
})
