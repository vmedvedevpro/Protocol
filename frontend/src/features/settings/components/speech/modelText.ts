/** How a speech model's facts read on its row. */

/** "25 languages", or "About 100 languages" for a model that lists all (`*`). */
export function languagesLine(languages: string[] | undefined): string | null {
    if (!languages?.length) return null
    if (languages.includes('*')) return 'About 100 languages'
    return `${languages.length} language${languages.length === 1 ? '' : 's'}`
}

/**
 * The catalog's description, its "•" between phrases ("Real time • Smaller
 * size") ending a sentence: the UI never joins text with a dot (#219).
 */
export const catalogLine = (description: string | undefined) => (description ?? '').replace(/\s*•\s*/g, '. ').trim()

/**
 * A row's facts: the first, then the rest in parentheses, "After meetings
 * (1.6 GB)" or "Better accuracy, moderate speed (488 MB, 25 languages)";
 * the empty ones left out.
 */
export function facts(first: string | null | undefined | false, ...rest: (string | null | undefined | false)[]): string {
    const more = rest.filter(Boolean).join(', ')
    if (!first) return more
    return more ? `${first} (${more})` : first
}
