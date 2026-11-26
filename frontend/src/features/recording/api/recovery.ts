/**
 * The crash copy of a recording: every live line goes to IndexedDB as it
 * arrives, so a meeting interrupted before its save (a crash, a killed
 * window, a failed save) can be saved later from it. The database is the
 * old UI's (`MeetilyRecoveryDB` v1, services/indexedDBService.ts at
 * 162e8be) and keeps its shape: a recording interrupted before the update
 * must still be recoverable after it (PARITY.md, Keep reading).
 *
 * - `meetings`, key `meetingId` ("meeting-<ms>", minted at
 *   `recording-started`), indexes `lastUpdated` and `savedToSQLite`.
 * - `transcripts`, auto-increment key, indexes `meetingId` and `storedAt`:
 *   each record is the `transcript-update` payload as native sent it, plus
 *   `meetingId` and `storedAt`.
 *
 * The audio is rebuilt from the checkpoints native writes during the
 * recording (audio/incremental_saver.rs).
 */
import {command} from '@/api/core'
import type {TranscriptUpdate} from './transcript'

/** The old UI's database name, kept so a copy made before the update is still found. */
export const RECOVERY_DB_NAME = 'MeetilyRecoveryDB'
const DB_VERSION = 1

/** A recording's record in `meetings`. Times are ms since the epoch. */
export interface RecoveryMeeting {
    meetingId: string
    title: string
    /** Whether the user chose `title` when the copy began (#218); absent in older copies. */
    titleManual?: boolean
    startTime: number
    lastUpdated: number
    transcriptCount: number
    savedToSQLite: boolean
    /** The recording's folder once native has made it, for its audio. */
    folderPath?: string
}

/**
 * A line in `transcripts`. The old UI wrote the update as it came
 * (`sequence_id`, `source`); `sequenceId` and `speaker` are read too, for
 * records an older build may have written that way.
 */
export interface RecoveryLine extends Partial<TranscriptUpdate> {
    id?: number
    meetingId: string
    storedAt: number
    text: string
    sequenceId?: number
    speaker?: string
}

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
    opening ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(RECOVERY_DB_NAME, DB_VERSION)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
            const db = request.result
            // Another tab's upgrade, or a test deleting the database, closes it.
            db.onversionchange = () => {
                db.close()
                opening = null
            }
            resolve(db)
        }
        request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains('meetings')) {
                const meetings = db.createObjectStore('meetings', {keyPath: 'meetingId'})
                meetings.createIndex('lastUpdated', 'lastUpdated', {unique: false})
                meetings.createIndex('savedToSQLite', 'savedToSQLite', {unique: false})
            }
            if (!db.objectStoreNames.contains('transcripts')) {
                const transcripts = db.createObjectStore('transcripts', {keyPath: 'id', autoIncrement: true})
                transcripts.createIndex('meetingId', 'meetingId', {unique: false})
                transcripts.createIndex('storedAt', 'storedAt', {unique: false})
            }
        }
    })
    opening.catch(() => {
        opening = null
    })
    return opening
}

const done = <T>(request: IDBRequest<T>) =>
    new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })

const committed = (tx: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })

/** A recording started: its record exists before any line, so a crash before the first line is offered too. */
export async function beginRecovery(meeting: Pick<RecoveryMeeting, 'meetingId' | 'title' | 'titleManual' | 'startTime'>) {
    const db = await open()
    const tx = db.transaction('meetings', 'readwrite')
    tx.objectStore('meetings').put({...meeting, lastUpdated: Date.now(), transcriptCount: 0, savedToSQLite: false})
    await committed(tx)
}

/** Records the folder native made for the recording, for its audio. */
export async function setRecoveryFolder(meetingId: string, folderPath: string) {
    const db = await open()
    const tx = db.transaction('meetings', 'readwrite')
    const store = tx.objectStore('meetings')
    const meeting = await done<RecoveryMeeting | undefined>(store.get(meetingId))
    if (meeting) store.put({...meeting, folderPath})
    await committed(tx)
}

/** Stores one line as native sent it, and counts it on the meeting. */
export async function storeRecoveryLine(meetingId: string, update: TranscriptUpdate) {
    const db = await open()
    const tx = db.transaction(['transcripts', 'meetings'], 'readwrite')
    tx.objectStore('transcripts').add({...update, meetingId, storedAt: Date.now()})
    const meetings = tx.objectStore('meetings')
    const meeting = await done<RecoveryMeeting | undefined>(meetings.get(meetingId))
    if (meeting) meetings.put({...meeting, lastUpdated: Date.now(), transcriptCount: meeting.transcriptCount + 1})
    await committed(tx)
}

/** The meeting was saved; its copy stays a day (`pruneRecovery`) and is never offered again. */
export async function markRecoverySaved(meetingId: string) {
    const db = await open()
    const tx = db.transaction('meetings', 'readwrite')
    const store = tx.objectStore('meetings')
    const meeting = await done<RecoveryMeeting | undefined>(store.get(meetingId))
    if (meeting) store.put({...meeting, savedToSQLite: true, lastUpdated: Date.now()})
    await committed(tx)
}

const DAY_MS = 24 * 60 * 60 * 1000
/** How long an interrupted meeting is kept and offered. */
export const RECOVERY_KEEP_MS = 7 * DAY_MS
/** How long a saved meeting's copy is kept: a day, should the save turn out wrong. */
export const RECOVERY_KEEP_SAVED_MS = DAY_MS
/**
 * A meeting updated this recently may still be recording in another window,
 * or have just been saved: not offered yet.
 */
export const RECOVERY_SETTLE_MS = 2_000

/** Every unsaved meeting updated within the last 7 days and not in the last 2 s, newest first. */
export async function listRecoverable(now = Date.now()): Promise<RecoveryMeeting[]> {
    const db = await open()
    const all = await done<RecoveryMeeting[]>(db.transaction('meetings').objectStore('meetings').getAll())
    return all
        .filter((meeting) => !meeting.savedToSQLite)
        .filter((meeting) => meeting.lastUpdated > now - RECOVERY_KEEP_MS && meeting.lastUpdated < now - RECOVERY_SETTLE_MS)
        .sort((a, b) => b.lastUpdated - a.lastUpdated)
}

/** A meeting's record, or null. */
export async function getRecoveryMeeting(meetingId: string): Promise<RecoveryMeeting | null> {
    const db = await open()
    return (await done<RecoveryMeeting | undefined>(db.transaction('meetings').objectStore('meetings').get(meetingId))) ?? null
}

/** The sequence of a stored line, in either shape. */
export const recoverySequence = (line: RecoveryLine) => line.sequence_id ?? line.sequenceId ?? 0

/** A meeting's lines in sequence order. */
export async function getRecoveryLines(meetingId: string): Promise<RecoveryLine[]> {
    const db = await open()
    const index = db.transaction('transcripts').objectStore('transcripts').index('meetingId')
    const lines = await done<RecoveryLine[]>(index.getAll(meetingId))
    return lines.sort((a, b) => recoverySequence(a) - recoverySequence(b))
}

async function deleteMeetings(ids: readonly string[]) {
    if (ids.length === 0) return
    const db = await open()
    const tx = db.transaction(['meetings', 'transcripts'], 'readwrite')
    const transcripts = tx.objectStore('transcripts').index('meetingId')
    for (const id of ids) {
        tx.objectStore('meetings').delete(id)
        const keys = await done(transcripts.getAllKeys(id))
        for (const key of keys) tx.objectStore('transcripts').delete(key)
    }
    await committed(tx)
}

/** Deletes a meeting's copy and its lines. */
export const deleteRecovery = (meetingId: string) => deleteMeetings([meetingId])

/**
 * Drops copies past their time: unsaved ones after 7 days, saved ones after
 * a day. The caller never runs it while a recording runs: the running
 * meeting's copy must stay.
 */
export async function pruneRecovery(now = Date.now()) {
    const db = await open()
    const all = await done<RecoveryMeeting[]>(db.transaction('meetings').objectStore('meetings').getAll())
    const stale = all.filter((meeting) =>
        meeting.lastUpdated < now - (meeting.savedToSQLite ? RECOVERY_KEEP_SAVED_MS : RECOVERY_KEEP_MS))
    await deleteMeetings(stale.map((meeting) => meeting.meetingId))
}

/** Closes the connection; tests delete the database between cases. */
export async function closeRecovery() {
    const pending = opening
    opening = null
    if (pending) (await pending.catch(() => null))?.close()
}

// ---------------------------------------------------------------------------
// The audio (src-tauri/src/audio/incremental_saver.rs)

/** Mirrors `AudioRecoveryStatus`. */
export interface AudioRecovery {
    status: 'success' | 'partial' | 'failed' | 'none'
    chunk_count: number
    estimated_duration_seconds: number
    audio_file_path?: string | null
    message: string
}

/** Whether native left audio checkpoints in the folder to rebuild the audio from. */
export const hasAudioCheckpoints = (meetingFolder: string) => command<boolean>('has_audio_checkpoints', {meetingFolder})

// Native writes checkpoints at its capture rate; the argument is kept for the
// command's signature, which ignores it.
const CHECKPOINT_SAMPLE_RATE = 48_000

/** Rebuilds the meeting's audio file from its checkpoints. */
export const recoverAudio = (meetingFolder: string) =>
    command<AudioRecovery>('recover_audio_from_checkpoints', {meetingFolder, sampleRate: CHECKPOINT_SAMPLE_RATE})

/** Deletes the checkpoints once the meeting is saved. */
export const cleanupCheckpoints = (meetingFolder: string) => command<null>('cleanup_checkpoints', {meetingFolder})
