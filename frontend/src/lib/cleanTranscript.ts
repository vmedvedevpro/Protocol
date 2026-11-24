/**
 * Labs › Clean transcript: the text a line shows without fillers ("um",
 * "uh", "er") and words said twice in a row. Only what is shown changes:
 * the saved transcript and its timestamps stay word for word. Ported from
 * the old app's `cleanTranscriptText` (`162e8be`, lib/labs.ts).
 */

// Doubled on purpose often enough that dropping one changes the meaning.
const KEEP_DOUBLED = new Set(['no', 'yes', 'very', 'never'])

export function cleanTranscriptText(text: string): string {
    const cleaned = text
        .replace(/\b(?:uh+|um+|erm|er)\b[,\s]*/gi, '')
        .replace(/\b([\p{L}\p{N}]+)(?:\s+\1)\b/giu, (pair, word: string) =>
            (KEEP_DOUBLED.has(word.toLowerCase()) ? pair : word))
        .replace(/\s+([,.!?;:])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
    return cleaned.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase())
}
