/**
 * The live transcript: lines native pushes while a recording runs
 * (`transcript-update`, audio/transcription/worker.rs), the history it keeps
 * for a WebView that reloads mid-recording, and the shapes the save after
 * Stop and the transcript list take them in.
 *
 * Times are seconds from the start of the recording, pauses left out, as
 * the saved audio has them.
 */
import {command} from '@/api/core'
import type {NativeEvent} from '@/api/events'
import type {TranscriptSegment} from '@/api/meetings'
import type {TranscriptLine} from '@/components/transcript/turns'

/** Mirrors `TranscriptUpdate`: one line, final unless `is_partial`. */
export interface TranscriptUpdate {
    text: string
    /** Wall-clock time, "14:30:05". */
    timestamp: string
    /**
     * Who spoke, as native labels it: "You" for the microphone, "Speaker N"
     * from live diarization, or "Guest" for computer audio without it.
     */
    source: string
    /** Orders the lines; unique within a recording. */
    sequence_id: number
    chunk_start_time: number
    is_partial: boolean
    confidence: number
    audio_start_time: number
    audio_end_time: number
    duration: number
}

export const TRANSCRIPT_UPDATE_EVENT = 'transcript-update' as NativeEvent<TranscriptUpdate>

/** Mirrors `recording_saver::TranscriptSegment`: a line of the running recording's history. */
export interface TranscriptHistorySegment {
    id: string
    text: string
    audio_start_time: number
    audio_end_time: number
    duration: number
    /** "[02:15]". */
    display_time: string
    confidence: number
    sequence_id: number
    speaker?: string | null
}

/** The running recording's lines so far, for a WebView that reloaded during it. */
export const getTranscriptHistory = () => command<TranscriptHistorySegment[]>('get_transcript_history')

/**
 * A line as the recording keeps it. `speaker` is what the transcript shows:
 * native's `source` with the user's renames replayed over it
 * (speakerEdits.ts); `source` stays as native labelled it, so the
 * microphone's "You" is never inferred from a name.
 */
export interface LiveLine {
    sequenceId: number
    text: string
    speaker: string
    source: string
    /** Seconds from the start. */
    start: number
    end: number
    /** Wall-clock time native stamped, "14:30:05". */
    timestamp: string
    confidence: number
}

export function lineFromUpdate(update: TranscriptUpdate, speaker: string): LiveLine {
    return {
        sequenceId: update.sequence_id,
        text: update.text,
        speaker,
        source: update.source,
        start: update.audio_start_time,
        end: update.audio_end_time,
        timestamp: update.timestamp,
        confidence: update.confidence,
    }
}

export function lineFromHistory(segment: TranscriptHistorySegment, speaker: string): LiveLine {
    return {
        sequenceId: segment.sequence_id,
        text: segment.text,
        speaker,
        source: segment.speaker ?? '',
        start: segment.audio_start_time,
        end: segment.audio_end_time,
        timestamp: segment.display_time,
        confidence: segment.confidence,
    }
}

/**
 * A line as the meeting saves it (`saveTranscript` in src/api/meetings.ts).
 * The speaker goes with every line: diarization after the call finds the
 * user by the microphone's "You" ranges.
 */
export const toSegment = (line: LiveLine): TranscriptSegment => ({
    id: String(line.sequenceId),
    text: line.text,
    timestamp: line.timestamp,
    audio_start_time: line.start,
    audio_end_time: line.end,
    duration: Math.max(0, line.end - line.start),
    speaker: line.speaker || undefined,
})

/** A line as the transcript list shows it. */
export const toTranscriptLine = (line: LiveLine): TranscriptLine => ({
    id: String(line.sequenceId),
    text: line.text,
    start: line.start,
    end: line.end,
    speaker: line.speaker || null,
})

/**
 * Lines in transcript order: by start, then by sequence for lines that start
 * together. Native's workers are serial, so a new line nearly always goes
 * last; the scan from the end keeps that case cheap.
 */
export function insertLine(lines: readonly LiveLine[], line: LiveLine): LiveLine[] {
    if (lines.some((each) => each.sequenceId === line.sequenceId)) return lines as LiveLine[]
    const after = (a: LiveLine, b: LiveLine) => a.start > b.start || (a.start === b.start && a.sequenceId > b.sequenceId)
    let at = lines.length
    while (at > 0 && after(lines[at - 1], line)) at--
    return [...lines.slice(0, at), line, ...lines.slice(at)]
}

/**
 * The lines as text, one a line with its speaker ("Speaker 2: …"), for the
 * clipboard and the live assistant. With a `budget` in characters, the
 * newest lines that fit, in order: a long meeting would not fit a model's
 * context, and recent talk matters most.
 */
export function transcriptText(lines: readonly LiveLine[], budget = Infinity): string {
    const kept: string[] = []
    let used = 0
    for (let at = lines.length - 1; at >= 0; at--) {
        const {speaker, text} = lines[at]
        const line = speaker ? `${speaker}: ${text.trim()}` : text.trim()
        // Each line costs its newline too.
        if (used + line.length + 1 > budget) break
        kept.push(line)
        used += line.length + 1
    }
    return kept.reverse().join('\n')
}
