/**
 * Stands in for `@blocknote/core/emoji-data`; vite.config.ts says why. Only
 * BlockNote's emoji picker loads that module, and the notes editor never
 * draws the picker, so nothing calls these.
 */
const missing = () => new Error('The notes editor has no emoji picker, so it ships no emoji data')

export async function loadFrimousseData(): Promise<never> {
    throw missing()
}

export function searchEmojis(): never {
    throw missing()
}
