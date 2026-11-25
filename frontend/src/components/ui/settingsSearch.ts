/** Letters and digits of any script; anything else separates words. */
const SEPARATOR = /[^\p{L}\p{N}]+/u

const words = (text: string) => text.toLocaleLowerCase().split(SEPARATOR).filter(Boolean)

/** The words of a settings query, lower case. */
export const searchTerms = (query: string) => words(query)

/**
 * Whether every word of the query starts a word of a row's text, ignoring
 * case: "model" finds "Model updates" and "models", "sum" finds "Summary",
 * but "odel" or "ear" (inside "Appearance") find nothing.
 */
export function matchesTerms(terms: string[], ...parts: (string | undefined)[]) {
    const text = words(parts.filter(Boolean).join(' '))
    return terms.every((term) => text.some((word) => word.startsWith(term)))
}
