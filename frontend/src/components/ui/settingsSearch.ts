/** The words of a settings query, lower case. */
export const searchTerms = (query: string) => query.toLocaleLowerCase().split(/\s+/).filter(Boolean)

/** Whether every word is in a row's text, ignoring case. */
export function matchesTerms(terms: string[], ...parts: (string | undefined)[]) {
    const text = parts.filter(Boolean).join(' ').toLocaleLowerCase()
    return terms.every((term) => text.includes(term))
}
