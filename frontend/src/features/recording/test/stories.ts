import {speakMockLine} from '@/mocks/live'
import {mockState} from '@/mocks/state'
import {RECOVERY_DB_NAME} from '../api/recovery'
import {automaticTitle} from '../lib/titles'
import {resetRecording} from '../store/reset'
import {session} from '../store/session'
import {startRecording} from '../store/start'

/**
 * Stories start from nothing recorded; the preview resets the mock itself.
 * Storybook's IndexedDB is the browser's and outlives a story, so the crash
 * copies a story left go too, or the next one would offer to recover them.
 */
export async function reset() {
    await resetRecording()
    await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(RECOVERY_DB_NAME)
        request.onsuccess = request.onerror = request.onblocked = resolve
    })
}

const MINUTES_IN = 724

/**
 * A recording 12 minutes in, with `lines` of the script spoken. The runtime
 * mounts after this and joins it as after a reload: the timer and the lines
 * come from the mock recorder.
 */
export async function startLiveRecording(lines = 0) {
    await startRecording()
    const startedAt = Date.now() - MINUTES_IN * 1000
    const title = automaticTitle(new Date(startedAt))
    const recording = mockState.live.recording
    if (recording) Object.assign(recording, {startedAt, meetingName: title})
    for (let line = 0; line < lines; line++) speakMockLine(mockState)
    session.set({clock: {seconds: MINUTES_IN, at: Date.now()}, startedAt, title})
}
