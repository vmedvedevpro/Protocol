/**
 * Transcript recovery (PARITY.md, Which meetings recovery offers): meetings
 * whose save never happened, offered once per session from their crash copy
 * (api/recovery.ts). Recover saves the copy as a meeting, with its audio
 * rebuilt from native's checkpoints when they are there.
 */
import {create} from 'zustand'
import {errorMessage} from '@/api/core'
import {folderKeys, meetingKeys, saveTranscript} from '@/api/meetings'
import {queries} from './queries'
import {
    type AudioRecovery,
    cleanupCheckpoints,
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
    /** Its first three lines, to tell the meetings apart. */
    preview: string
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
        const lines = await getRecoveryLines(meeting.meetingId)
        const preview = lines.slice(0, 3).map((line) => line.text.trim()).join(' ')
        const audio = meeting.folderPath ? await hasAudioCheckpoints(meeting.folderPath).catch(() => false) : false
        return {...meeting, lines: lines.length, preview, audio}
    }))
    return offered.filter((meeting) => meeting.lines > 0)
}

export interface Recovered {
    meetingId: string
    audio: AudioRecovery | null
}

/**
 * Recoveries running now. No native busy reason covers the audio rebuild and
 * the save, so RecordingRuntime reports them to the updater as
 * `recordingSave` while the count is above 0.
 */
const useRecoveringStore = create<{ count: number }>(() => ({count: 0}))

export const useRecovering = () => useRecoveringStore((state) => state.count > 0)

/** Saves an interrupted meeting from its copy, with its audio when it can be rebuilt. */
export async function recoverMeeting(recoveryId: string): Promise<Recovered> {
    useRecoveringStore.setState(({count}) => ({count: count + 1}))
    try {
        return await saveRecovered(recoveryId)
    } finally {
        useRecoveringStore.setState(({count}) => ({count: count - 1}))
    }
}

async function saveRecovered(recoveryId: string): Promise<Recovered> {
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
            message: errorMessage(error),
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
        // A copy made before the record existed keeps its title.
        titleIsManual: meeting.titleManual ?? true,
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
