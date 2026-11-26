/**
 * The moment a recording runs, whichever way it started: the session takes
 * its crash copy's id and starts the timer (PARITY.md: the recording state
 * comes from `recording-started`, not from the start call).
 */
import {getMeetingFolderPath, getRecordingMeetingName} from '../api/recording'
import {beginRecovery, setRecoveryFolder} from '../api/recovery'
import {session} from './session'

/** Records the folder native made, so a crash copy can rebuild the audio. */
export async function noteRecoveryFolder(recoveryId: string) {
    const folder = await getMeetingFolderPath().catch(() => null)
    if (folder) await setRecoveryFolder(recoveryId, folder).catch(() => undefined)
}

/**
 * Native's `recording-started`, or the start's answer if it comes first;
 * the second of the two does nothing.
 */
export async function beginSession() {
    const state = session.get()
    if (state.recoveryId && (state.phase === 'recording' || state.phase === 'paused')) return
    const recoveryId = `meeting-${Date.now()}`
    const startedAt = state.startedAt ?? Date.now()
    session.set({
        phase: 'recording',
        step: null,
        recoveryId,
        startedAt,
        clock: {seconds: 0, at: Date.now()},
        muted: {mic: false, system: false},
    })
    const title = state.title || (await getRecordingMeetingName().catch(() => null)) || ''
    if (!state.title) session.set({title})
    // The crash copy exists before the first line, so even a crash then is offered.
    await beginRecovery({meetingId: recoveryId, title, titleManual: session.get().titleManual, startTime: startedAt}).catch(() => undefined)
    await noteRecoveryFolder(recoveryId)
}
