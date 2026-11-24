/**
 * Where the main window's recording is, for screens outside the recording
 * feature: Settings locks the meeting language while one runs, and others
 * may hide what must not change mid-recording. The updater's busy snapshot
 * says the same only after a round trip; this follows the recording's own
 * session as it changes.
 *
 * The recording session in features/recording is the only writer: it sets
 * the phase from native events and from its start and stop sequences. Read
 * it with `useRecordingPhase`, or `recordingPhase.get()` outside React.
 */
import {create} from 'zustand'

/**
 * - `idle`: nothing records, and nothing is being saved.
 * - `starting`: Record was pressed; the speech model loads and capture opens.
 * - `recording`, `paused`: a recording runs.
 * - `finishing`: Stop was pressed; the last words are transcribed and the
 *   meeting is saved. The post-call pass after it is `usePostCallJob`'s.
 */
export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'paused' | 'finishing'

const usePhaseStore = create<{ phase: RecordingPhase }>(() => ({phase: 'idle'}))

export const recordingPhase = {
    get: (): RecordingPhase => usePhaseStore.getState().phase,
    /** The recording session's write; nothing else sets it. */
    set: (phase: RecordingPhase) => usePhaseStore.setState({phase}),
}

/** The recording's phase, re-rendering when it changes. */
export function useRecordingPhase(): RecordingPhase {
    return usePhaseStore((state) => state.phase)
}

/**
 * Whether a recording is starting, runs or is being saved: the phases in
 * which what it was started with (the meeting language) must not change.
 */
export function useRecordingBusy(): boolean {
    return usePhaseStore((state) => state.phase !== 'idle')
}
