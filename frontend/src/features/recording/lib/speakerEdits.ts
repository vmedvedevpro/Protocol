/**
 * Names given to voices during a recording, kept per recording in
 * localStorage (`meetily-speaker-edits:<recoveryId>`, PARITY.md: keep
 * reading) and replayed over the live history after a reload and over the
 * crash copy on recovery. The key is the recovery id minted at
 * `recording-started`, not the saved meeting's id; keys are never removed.
 *
 * Native's labels stay as they came: an edit only changes what is shown and
 * saved, and the microphone's "You" is never renamed or inferred.
 */
import {speakerParts} from '@/components/transcript/turns'

interface Edits {
    /** A native label, or an earlier name, to the name it now shows. */
    aliases: Record<string, string>
    /** A line (by sequence id) moved to another voice. */
    turns: Record<string, string>
}

const key = (recoveryId: string) => `meetily-speaker-edits:${recoveryId}`

function read(recoveryId: string): Edits {
    const stored = localStorage.getItem(key(recoveryId))
    if (!stored) return {aliases: {}, turns: {}}
    const edits = JSON.parse(stored) as Edits
    if (!edits.aliases || !edits.turns) throw new Error('Invalid saved speaker edits')
    return edits
}

/** Replaces one voice of a label ("Speaker 2 + You") with another name; duplicates fold. */
export function replaceSpeakerPart(label: string, from: string, to: string): string {
    const parts = speakerParts(label).map((part) => (part === from.trim() ? to.trim() : part))
    return [...new Set(parts)].join(' + ')
}

// A chain of renames is followed to its end; a cycle (a name given back) stops it.
function resolve(label: string, aliases: Record<string, string>): string {
    const parts = speakerParts(label)
    if (parts.length > 1) return [...new Set(parts.map((part) => resolve(part, aliases)))].join(' + ')
    let current = label.trim()
    const seen = new Set<string>()
    while (Object.hasOwn(aliases, current) && aliases[current] !== current && !seen.has(current)) {
        seen.add(current)
        current = aliases[current].trim()
    }
    return current
}

/** What a line of `source` (native's label) shows, with this recording's edits replayed. */
export function editedSpeaker(recoveryId: string | null, sequenceId: number, source: string): string {
    if (!recoveryId || !source) return source
    try {
        const edits = read(recoveryId)
        if (Object.hasOwn(edits.turns, String(sequenceId))) return edits.turns[String(sequenceId)] || source
        return resolve(source, edits.aliases)
    } catch {
        return source
    }
}

/**
 * Stores a rename before the screen shows it, so a failed write never looks
 * saved; throws when storage refuses it.
 */
export function storeSpeakerRename(recoveryId: string, from: string, to: string) {
    const edits = read(recoveryId)
    // Earlier names are rewritten in place; resolving a chain can cycle when a name comes back.
    for (const [label, name] of Object.entries(edits.aliases)) edits.aliases[label] = replaceSpeakerPart(name, from, to)
    for (const [turn, name] of Object.entries(edits.turns)) edits.turns[turn] = replaceSpeakerPart(name, from, to)
    // defineProperty: a voice named "__proto__" must stay a plain key.
    Object.defineProperty(edits.aliases, from.trim(), {value: to.trim(), enumerable: true, writable: true, configurable: true})
    localStorage.setItem(key(recoveryId), JSON.stringify(edits))
}
