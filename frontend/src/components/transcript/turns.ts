import type {TranscriptSegment} from '@/api/meetings'

/**
 * One line as the transcript view shows it, saved or live. A saved meeting
 * maps its `TranscriptSegment`s with `lineFromSegment`; the live transcript
 * (#112) maps each `transcript-update` the same way.
 */
export interface TranscriptLine {
    id: string
    text: string
    /** Seconds from the start of the recording; null for lines saved without times. */
    start: number | null
    end?: number | null
    /** "You", "Speaker N", a name, or overlapping voices joined by " + ". */
    speaker?: string | null
}

/** Consecutive lines of one voice, shown as one row. Its id is its first line's. */
export interface Turn {
    id: string
    text: string
    start: number | null
    end: number | null
    speaker: string | null
    /** The ids of the lines it joins. */
    lineIds: string[]
}

export function lineFromSegment(segment: TranscriptSegment): TranscriptLine {
    return {
        id: segment.id,
        text: segment.text,
        start: segment.audio_start_time ?? null,
        end: segment.audio_end_time ?? null,
        speaker: segment.speaker ?? null,
    }
}

/** Overlap labels use the diarizer's spaced separator; a name never contains it. */
export function speakerParts(speaker: string): string[] {
    return speaker.split(' + ').map((part) => part.trim()).filter(Boolean)
}

/**
 * The microphone's own label: "You", or "Name (You)" as older versions
 * wrote it. Identity comes from the microphone, never from a speaker
 * number (see PARITY.md, `You` comes from the microphone source).
 */
export function isUserSpeaker(speaker: string | null | undefined): boolean {
    const label = speaker?.trim() ?? ''
    return speakerParts(label).length === 1 && (/^you$/i.test(label) || /\(\s*you\s*\)$/i.test(label))
}

/** A voice nobody named yet: "Speaker 2", "Guest". */
export function isUnnamedSpeaker(speaker: string | null | undefined): boolean {
    const label = speaker?.trim() ?? ''
    return !label || /^speaker(\s+\d+)?$/i.test(label) || /^guest\b/i.test(label)
}

/** The label as shown: the user's own voice carries their name when there is one. */
export function displaySpeaker(speaker: string, userName?: string): string {
    return speakerParts(speaker)
        .map((part) => (isUserSpeaker(part) ? (userName ? `${userName} (You)` : 'You') : part))
        .join(' + ')
}

/** Compares labels the way the turns join them: case aside, every form of "You" alike. */
export function speakerKey(speaker: string | null | undefined): string {
    if (isUserSpeaker(speaker)) return '__you__'
    return speaker?.trim().toLowerCase() || '__unknown__'
}

/** Lines of one voice less than this many seconds apart join into one turn. */
export const TURN_GAP_SECONDS = 2.5

/**
 * Joins consecutive lines of one voice into turns. Live transcription and
 * the passes after a call cut speech into short pieces; a row per piece
 * would repeat the name every few words. Lines without times never join.
 */
export function joinTurns(lines: readonly TranscriptLine[]): Turn[] {
    const turns: Turn[] = []
    for (const line of lines) {
        const last = turns.at(-1)
        const lastEnd = last?.end ?? last?.start
        const gap = line.start !== null && lastEnd !== null && lastEnd !== undefined ? line.start - lastEnd : null
        if (last && gap !== null && gap >= 0 && gap <= TURN_GAP_SECONDS && speakerKey(last.speaker) === speakerKey(line.speaker)) {
            last.text = `${last.text.trim()} ${line.text.trim()}`.trim()
            last.end = line.end ?? line.start
            last.lineIds.push(line.id)
        } else {
            turns.push({
                id: line.id,
                text: line.text.trim(),
                start: line.start,
                end: line.end ?? line.start,
                speaker: line.speaker?.trim() || null,
                lineIds: [line.id],
            })
        }
    }
    return turns
}

/**
 * The turn being played at `seconds`: the last one that started by then, so
 * the highlight stays on a turn through the pause after it instead of
 * blinking off; -1 before the first. Turns are in start order, and a binary
 * search keeps a tick cheap on a long meeting.
 */
export function activeTurnIndex(turns: readonly Turn[], seconds: number): number {
    let low = 0
    let high = turns.length - 1
    let found = -1
    while (low <= high) {
        const middle = (low + high) >> 1
        const start = turns[middle].start
        // A seek lands on a turn's start; rounding must not leave it on the one before.
        if (start !== null && start <= seconds + 0.05) {
            found = middle
            low = middle + 1
        } else {
            high = middle - 1
        }
    }
    return found
}

/** `mm:ss`, or `h:mm:ss` past an hour. */
export function formatClock(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds))
    const hours = Math.floor(total / 3600)
    const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
    const rest = String(total % 60).padStart(2, '0')
    return hours > 0 ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`
}
