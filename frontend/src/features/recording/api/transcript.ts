/**
 * The live transcript: lines native pushes while a recording runs
 * (`transcript-update`, audio/transcription/worker.rs), the history it keeps
 * for a WebView that reloads mid-recording, and the save that turns the
 * lines into the meeting after Stop (api.rs `api_save_transcript`).
 *
 * Times are seconds from the start of the recording, pauses left out, as
 * the saved audio has them.
 */
import {command} from '@/api/core'
import type {NativeEvent} from '@/api/events'

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

/** Mirrors api.rs `TranscriptSegment`, what the save reads. */
interface SavedSegment {
    id: string
    text: string
    timestamp: string
    audio_start_time: number
    audio_end_time: number
    duration: number
    /** Kept on every line: diarization later finds the user by the microphone's "You" ranges. */
    speaker?: string
}

const toSaved = (line: LiveLine): SavedSegment => ({
    id: String(line.sequenceId),
    text: line.text,
    timestamp: line.timestamp,
    audio_start_time: line.start,
    audio_end_time: line.end,
    duration: Math.max(0, line.end - line.start),
    speaker: line.speaker || undefined,
})

/**
 * Saves a recording as a meeting with these lines and returns its id. Native
 * takes the start time from the folder's metadata when it has one, else from
 * `recordingStartedAt` (RFC 3339); a title starting "Meeting · " is saved as
 * automatic, so the summary may rename it.
 */
export async function saveTranscript(
    title: string,
    lines: readonly LiveLine[],
    folderPath: string | null,
    recordingStartedAt: string | null,
): Promise<string> {
    const reply = await command<{ meeting_id?: string }>('api_save_transcript', {
        meetingTitle: title,
        transcripts: lines.map(toSaved),
        folderPath,
        recordingStartedAt,
    })
    if (!reply.meeting_id) throw new Error('The meeting was saved without an id')
    return reply.meeting_id
}

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
