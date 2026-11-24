/**
 * The main window's recording: client state that follows native's recorder
 * (src-tauri/src/audio/recording_commands.rs). Native owns capture, the
 * timer and finalization; this store mirrors what native says through its
 * events, and owns what only the WebView knows until the meeting is saved:
 * the title typed or picked, the folder, the live lines in transcript order,
 * the names given to voices, and the notes.
 *
 * Its phase is written to `recordingPhase` (src/api), which screens outside
 * the recording read. The sequences that change it live beside it: start.ts
 * (Record) and save.ts (Stop and the save native hands over).
 */
import {create} from 'zustand'
import type {AudioSource} from '@/api/audio'
import {type RecordingPhase, recordingPhase} from '@/api/recordingPhase'
import type {NotesContent} from '@/components/editor/NotesEditor'
import {replaceSpeakerPart} from '../lib/speakerEdits'
import {insertLine, type LiveLine} from '../api/transcript'

/** The folder the meeting is filed in when it is saved. */
export interface SessionFolder {
    id: string
    name: string
}

/**
 * The timer: `seconds` of recording (pauses left out) at `at` (Date.now()),
 * counting on from there while it runs. Native's `active_duration` corrects
 * it on every sync.
 */
export interface SessionClock {
    seconds: number
    at: number
}

export interface SessionState {
    phase: RecordingPhase
    /** What a start or a save is doing, said in the bar while it lasts. */
    step: string | null
    clock: SessionClock
    muted: Record<AudioSource, boolean>
    /**
     * The crash copy's id, "meeting-<ms>", minted when the recording starts;
     * it also keys the names given to voices (speakerEdits.ts).
     */
    recoveryId: string | null
    /** When the recording started (Date.now()): its automatic title and the saved meeting's date. */
    startedAt: number | null
    title: string
    /** The user typed the title: picking a folder no longer retitles the meeting. */
    titleManual: boolean
    folder: SessionFolder | null
    /** The live transcript in transcript order (`insertLine`). */
    lines: LiveLine[]
    /** The notes typed during the recording; saved on the meeting after Stop. */
    notes: NotesContent | null
    /** Why recording cannot work at all (`is_recording` failed); null when it can. */
    unavailable: string | null
}

const IDLE_CLOCK: SessionClock = {seconds: 0, at: 0}

const initial = (): SessionState => ({
    phase: 'idle',
    step: null,
    clock: IDLE_CLOCK,
    muted: {mic: false, system: false},
    recoveryId: null,
    startedAt: null,
    title: '',
    titleManual: false,
    folder: null,
    lines: [],
    notes: null,
    unavailable: null,
})

export const useSessionStore = create<SessionState>(initial)

// The shared phase follows the session, whoever changed it.
useSessionStore.subscribe((state, previous) => {
    if (state.phase !== previous.phase) recordingPhase.set(state.phase)
})

export const session = {
    get: () => useSessionStore.getState(),
    set: (change: Partial<SessionState>) => useSessionStore.setState(change),
    /** Back to nothing recorded; the folder stays picked for the next recording. */
    clear() {
        const {folder, unavailable} = useSessionStore.getState()
        useSessionStore.setState({...initial(), folder, unavailable})
    },
    /** Tests and stories, between cases. */
    reset() {
        useSessionStore.setState(initial())
    },
}

/** The seconds on the timer at `now`. */
export function clockSeconds(state: Pick<SessionState, 'clock' | 'phase'>, now = Date.now()): number {
    const running = state.phase === 'recording'
    return state.clock.seconds + (running && state.clock.at > 0 ? Math.max(0, now - state.clock.at) / 1000 : 0)
}

/**
 * Capture is ending: the timer stops at the take's length, which the save
 * reads (a take under 10 s is discarded). Only a running or paused session
 * moves on; one already finishing keeps its clock.
 */
export function finishSession(step = 'Finishing…', now = Date.now()) {
    const state = useSessionStore.getState()
    if (state.phase !== 'recording' && state.phase !== 'paused') return
    useSessionStore.setState({phase: 'finishing', step, clock: {seconds: clockSeconds(state, now), at: now}})
}

/** Stops the timer where it is (pause) or starts it again (resume). */
export function holdClock(paused: boolean, now = Date.now()) {
    const state = useSessionStore.getState()
    const seconds = clockSeconds(state, now)
    useSessionStore.setState({phase: paused ? 'paused' : 'recording', clock: {seconds, at: now}})
}

/** "12:04", or "1:02:09" past the hour. */
export function formatTimer(totalSeconds: number): string {
    const whole = Math.max(0, Math.floor(totalSeconds))
    const hours = Math.floor(whole / 3600)
    const minutes = Math.floor((whole % 3600) / 60)
    const seconds = String(whole % 60).padStart(2, '0')
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** Adds a live line where it belongs; a line already there (same sequence) is kept. */
export function addLine(line: LiveLine) {
    useSessionStore.setState(({lines}) => ({lines: insertLine(lines, line)}))
}

/** Shows `to` wherever `from` spoke, in lines here and lines still to come. */
export function renameVoice(from: string, to: string) {
    useSessionStore.setState(({lines}) => ({
        lines: lines.map((line) => (line.speaker ? {...line, speaker: replaceSpeakerPart(line.speaker, from, to)} : line)),
    }))
}

/** The voices of the live transcript, in the order they first spoke. */
export function voicesOf(lines: readonly LiveLine[]): string[] {
    const seen = new Set<string>()
    for (const line of lines) if (line.speaker) seen.add(line.speaker)
    return [...seen]
}
