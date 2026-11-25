/**
 * Words to recognize as a list. Native stores one text (`api_get_vocabulary`,
 * `api_save_global_vocabulary`) and normalises it in vocabulary.rs
 * `normalize`: split on commas and line breaks, trimmed, blanks dropped,
 * repeats dropped whatever their case, one per line. These functions apply
 * the same rule, so the list shown is the list native keeps.
 */
import {MAX_VOCABULARY_CHARS} from '@/api/speech'

/** The entries of a stored or typed text, in order. */
export function parseVocabulary(text: string): string[] {
    const seen = new Set<string>()
    const terms: string[] = []
    for (const part of text.split(/[,\n\r]/)) {
        const term = part.trim()
        const key = term.toLowerCase()
        if (!term || seen.has(key)) continue
        seen.add(key)
        terms.push(term)
    }
    return terms
}

/** The text native stores for a list. */
export const formatVocabulary = (terms: readonly string[]) => terms.join('\n')

/** Native counts characters, not UTF-16 units. */
const characters = (text: string) => [...text].length

/**
 * The list with what was typed added at the end; a comma in it makes two
 * entries, as native would. `full` when the list would pass the limit native
 * keeps, and the list unchanged when the text is blank or already listed.
 */
export function addToVocabulary(terms: readonly string[], typed: string): string[] | 'full' {
    const next = parseVocabulary(formatVocabulary([...terms, typed]))
    return characters(formatVocabulary(next)) > MAX_VOCABULARY_CHARS ? 'full' : next
}

export const removeFromVocabulary = (terms: readonly string[], term: string) => terms.filter((each) => each !== term)
