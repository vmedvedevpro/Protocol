/**
 * Transcript recovery (PARITY.md, Which meetings recovery offers): meetings
 * whose save never happened, offered once per session from their crash copy
 * (api/recovery.ts). Recover saves the copy as a meeting, with its audio
 * rebuilt from native's checkpoints when they are there.
 */
import {folderKeys, meetingKeys, saveTranscript} from '@/api/meetings'
import {queries} from './queries'
import {
    type AudioRecovery,
    cleanupCheckpoints,
    deleteRecovery,
    getRecoveryLines,
    getRecoveryMeeting,
    hasAudioCheckpoints,
    listRecoverable,
    markRecoverySaved,
    pruneRecovery,
    type RecoveryMeeting,
    recoverAudio,
    recoverySequence,
} from '../api/recovery'
import type {TranscriptSegment} from '@/api/meetings'
import {editedSpeaker} from '../lib/speakerEdits'
import {session} from './session'
import {applySummaryLanguage} from './summaryLanguage'

// Once per page load: a reload or a new session offers them again.
let offered = false

/** True the first time in this page: the recovery sheet looks once. */
export function claimRecoveryOffer(): boolean {
    if (offered) return false
    offered = true
    return true
}

/** Forgets the offer, for tests. */
export function resetRecoveryOffer() {
    offered = false
}

/** A meeting the recovery sheet offers. */
export interface RecoverableMeeting extends RecoveryMeeting {
    lines: number
    /** Native left audio checkpoints to rebuild its audio from. */
    audio: boolean
}

/**
 * Prunes old copies and lists the meetings to offer: unsaved, updated
 * within 7 days and not in the last 2 s. A meeting without lines is not
 * offered: there is nothing to save (its record is made before the first
 * line, and the old UI offered it only to fail on Recover).
 */
export async function findRecoverable(): Promise<RecoverableMeeting[]> {
    // Never while a recording runs: its own copy must stay.
    if (session.get().phase === 'idle') await pruneRecovery().catch(() => undefined)
    const recoveryId = session.get().recoveryId
    const meetings = (await listRecoverable()).filter((meeting) => meeting.meetingId !== recoveryId)
    const offered = await Promise.all(meetings.map(async (meeting) => {
        const lines = (await getRecoveryLines(meeting.meetingId)).length
        const audio = meeting.folderPath ? await hasAudioCheckpoints(meeting.folderPath).catch(() => false) : false
        return {...meeting, lines, audio}
    }))
    return offered.filter((meeting) => meeting.lines > 0)
}

export interface Recovered {
    meetingId: string
    audio: AudioRecovery | null
}

/** Saves an interrupted meeting from its copy, with its audio when it can be rebuilt. */
export async function recoverMeeting(recoveryId: string): Promise<Recovered> {
    const meeting = await getRecoveryMeeting(recoveryId)
    if (!meeting) throw new Error('This meeting is no longer in the recovery copy.')
    const lines = await getRecoveryLines(recoveryId)
    if (lines.length === 0) throw new Error('No transcript was found for this meeting.')

    const folder = meeting.folderPath ?? null
    let audio: AudioRecovery | null = null
    if (folder && (await hasAudioCheckpoints(folder).catch(() => false))) {
        audio = await recoverAudio(folder).catch((error) => ({
            status: 'failed' as const,
            chunk_count: 0,
            estimated_duration_seconds: 0,
            message: error instanceof Error ? error.message : String(error),
        }))
    }

    const segments: TranscriptSegment[] = lines.map((line, index) => {
        const sequence = recoverySequence(line) || index
        const start = line.audio_start_time ?? 0
        const end = line.audio_end_time ?? start
        return {
            id: String(sequence),
            text: line.text,
            timestamp: line.timestamp ?? '',
            audio_start_time: start,
            audio_end_time: end,
            duration: line.duration ?? Math.max(0, end - start),
            speaker: editedSpeaker(recoveryId, sequence, line.speaker ?? line.source ?? '') || undefined,
        }
    })
    const meetingId = await saveTranscript({
        title: meeting.title,
        transcripts: segments,
        folderPath: folder,
        recordingStartedAt: new Date(meeting.startTime).toISOString(),
    })
    await applySummaryLanguage(meetingId, segments.map((segment) => segment.text))
    await markRecoverySaved(recoveryId)
    if (folder) await cleanupCheckpoints(folder).catch(() => undefined)
    void queries().invalidateQueries({queryKey: meetingKeys.lists()})
    void queries().invalidateQueries({queryKey: folderKeys.all})
    return {meetingId, audio}
}

/** Deletes an interrupted meeting's copy for good. */
export const deleteRecoverable = (recoveryId: string) => deleteRecovery(recoveryId)
