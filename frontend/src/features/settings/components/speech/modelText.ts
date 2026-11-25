/** How a speech model's facts read on its row. */

/** "25 languages", or "About 100 languages" for a model that lists all (`*`). */
export function languagesLine(languages: string[] | undefined): string | null {
    if (!languages?.length) return null
    if (languages.includes('*')) return 'About 100 languages'
    return `${languages.length} language${languages.length === 1 ? '' : 's'}`
}

/** The catalog's description with its "•" written as the UI's "·". */
export const catalogLine = (description: string | undefined) => (description ?? '').replace(/\s*•\s*/g, ' · ').trim()

/** A row's facts, the empty ones left out. */
export const facts = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(' · ')
