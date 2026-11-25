import {describe, expect, it} from 'vitest'
import {MAX_VOCABULARY_CHARS} from '@/api/speech'
import {addToVocabulary, formatVocabulary, parseVocabulary, removeFromVocabulary} from './vocabulary'

describe('the vocabulary list', () => {
    it('reads native’s text as native normalises it', () => {
        // vocabulary.rs `normalizes_and_deduplicates_terms`.
        expect(parseVocabulary(' Meetily, Tauri\nmeetily \r\n OKR ')).toEqual(['Meetily', 'Tauri', 'OKR'])
        expect(parseVocabulary('')).toEqual([])
    })

    it('round-trips a list through the stored text', () => {
        const terms = ['Acme', 'Priya Shah', 'Parakeet']
        expect(formatVocabulary(terms)).toBe('Acme\nPriya Shah\nParakeet')
        expect(parseVocabulary(formatVocabulary(terms))).toEqual(terms)
    })

    it('adds a trimmed entry, and ignores blanks and repeats in any case', () => {
        expect(addToVocabulary(['Acme'], '  Contoso  ')).toEqual(['Acme', 'Contoso'])
        expect(addToVocabulary(['Acme'], '   ')).toEqual(['Acme'])
        expect(addToVocabulary(['Acme'], 'ACME')).toEqual(['Acme'])
        // A comma splits, as native would split it when saved.
        expect(addToVocabulary([], 'Acme, Contoso')).toEqual(['Acme', 'Contoso'])
    })

    it('refuses an entry that would pass native’s limit', () => {
        const long = 'x'.repeat(MAX_VOCABULARY_CHARS - 2)
        expect(addToVocabulary([long], 'y')).toEqual([long, 'y'])
        expect(addToVocabulary([long], 'yz')).toBe('full')
    })

    it('removes one entry', () => {
        expect(removeFromVocabulary(['Acme', 'Contoso'], 'Acme')).toEqual(['Contoso'])
    })
})
