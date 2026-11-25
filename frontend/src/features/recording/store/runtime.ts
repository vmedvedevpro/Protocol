/**
 * The session's side of native's events and commands: what each recording
 * event changes, the sync after the WebView loads (a reload mid-recording
 * finds native still recording), and the controls the bar and the screen
 * call. RecordingRuntime (components) subscribes these to the events.
 */
import type {AudioSource} from '@/api/audio'
import {errorMessage} from '@/api/core'
import type {AudioDevice} from '@/api/devices'
import {meetingsQuery} from '@/api/meetings'
import {toast} from '@/components/ui/toastStore'
import {queries} from './queries'
import {
    attemptDeviceReconnect,
    type AudioRouteWarning,
    getRecordingMeetingName,
    getRecordingState,
    isRecording,
    type MuteChanged,
    pauseRecording,
    type RecordingStopped,
    resumeRecording,
    setMicrophoneMuted,
    setSystemAudioMuted,
    type TranscriptionErrorPayload,
} from '../api/recording'
import {beginRecovery, listRecoverable, setRecoveryFolder, storeRecoveryLine} from '../api/recovery'
import {getTranscriptHistory, lineFromHistory, lineFromUpdate, type TranscriptUpdate} from '../api/transcript'
import {editedSpeaker, storeSpeakerRename} from '../lib/speakerEdits'
import {automaticTitle} from '../lib/titles'
import {beginSession, noteRecoveryFolder} from './begin'
import {links} from './links'
import {restoreLiveNotes} from './liveNotes'
import {stopRecording} from './save'
import {addLine, clockSeconds, finishSession, holdClock, renameVoice, session, type SessionFolder} from './session'
import {startRecording} from './start'

/** `recording-started`. */
export const onRecordingStarted = beginSession

/** Capture ended, from whatever stopped it; the save comes with `recording-stop-complete`. */
export function onRecordingStopped(stopped: RecordingStopped) {
    const {recoveryId} = session.get()
    finishSession()
    if (recoveryId && stopped.folder_path) void setRecoveryFolder(recoveryId, stopped.folder_path).catch(() => undefined)
}

/** Paused or resumed, from here or the minibar; native's timer corrects ours. */
export async function onPauseChanged(paused: boolean) {
    const {phase} = session.get()
    if (phase !== 'recording' && phase !== 'paused') return
    holdClock(paused)
    const state = await getRecordingState().catch(() => null)
    if (state?.active_duration != null) session.set({clock: {seconds: state.active_duration, at: Date.now()}})
}

export function onMuteChanged(source: AudioSource, change: MuteChanged) {
    session.set({muted: {...session.get().muted, [source]: change.muted}})
}

/** A live line: shown in place, with this recording's names, and copied for recovery. */
export function onTranscriptUpdate(update: TranscriptUpdate) {
    const {recoveryId} = session.get()
    addLine(lineFromUpdate(update, editedSpeaker(recoveryId, update.sequence_id, update.source)))
    if (recoveryId) void storeRecoveryLine(recoveryId, update).catch(() => undefined)
}

export function onAudioRouteWarning(warning: AudioRouteWarning) {
    // In the app for 30 s: the OS notification it once had is gone (#126).
    toast.warning(warning.title, {description: warning.message, duration: 30_000, id: 'audio-route-warning'})
}

export function onLiveDiarizationError(reason: string) {
    toast.warning('Live speaker labeling unavailable', {
        description: `${reason} The transcript keeps “You” for your microphone and “Guest” for computer audio.`,
        id: 'live-diarization-error',
    })
}

export function onTranscriptionError(error: TranscriptionErrorPayload) {
    // A start that fails this way rejects too, and the start reports it.
    if (session.get().phase === 'starting') return
    if (!error.actionable) {
        toast.error('Transcription stopped', {description: error.userMessage})
        return
    }
    // The speech model needs the user; what was said so far is kept.
    void stopRecording()
    toast.error('The recording stopped', {
        description: error.userMessage,
        action: {label: 'Speech models', onClick: () => links.openSpeechModels()},
        duration: Infinity,
    })
}

export function onTranscriptionWarning(reason: string) {
    toast.warning('Some speech could not be transcribed', {description: reason, id: 'transcription-warning'})
}

export function onRecordingError(reason: string) {
    toast.error(reason || 'Recording stopped because audio capture failed.', {duration: 10_000})
    // Native stops the recording itself and then hands it over to save.
    finishSession()
}

/**
 * Joins a recording native is already running: after a reload of the
 * window, the timer, mutes, title and lines come back from native, the
 * notes from storage, and the crash copy is found again by its title.
 */
export async function syncWithNative() {
    let recording: boolean
    try {
        recording = await isRecording()
    } catch {
        session.set({unavailable: 'Recording is unavailable. Restart Protocol to record.'})
        return
    }
    session.set({unavailable: null})
    const current = session.get()
    if (!recording) {
        if (current.phase === 'recording' || current.phase === 'paused') session.clear()
        return
    }
    if (current.phase === 'starting' || current.phase === 'finishing') return

    const [state, name, history] = await Promise.all([
        // Native records either way: without its state the session still
        // joins, keeping what it last knew of the timer, the pause and mutes.
        getRecordingState().catch(() => null),
        getRecordingMeetingName().catch(() => null),
        getTranscriptHistory().catch(() => []),
    ])
    const now = Date.now()
    const seconds = state ? state.active_duration ?? 0 : clockSeconds(current, now)
    const startedAt = current.startedAt ?? now - (state?.recording_duration ?? seconds) * 1000
    const title = current.title || name || ''
    let recoveryId = current.recoveryId
    if (!recoveryId) {
        // The newest unsaved copy of this recording; one that moved on in the last seconds counts.
        const copies = await listRecoverable(now + 60_000).catch(() => [])
        recoveryId = copies.find((copy) => copy.title === title && copy.startTime <= now)?.meetingId ?? null
        if (!recoveryId) {
            recoveryId = `meeting-${now}`
            await beginRecovery({meetingId: recoveryId, title, startTime: startedAt}).catch(() => undefined)
            void noteRecoveryFolder(recoveryId)
        }
    }
    const paused = state ? state.is_paused : current.phase === 'paused'
    session.set({
        phase: paused ? 'paused' : 'recording',
        step: null,
        clock: {seconds, at: now},
        muted: state ? {mic: state.is_microphone_muted, system: state.is_system_audio_muted} : current.muted,
        recoveryId,
        startedAt,
        title,
    })
    for (const segment of history) {
        addLine(lineFromHistory(segment, editedSpeaker(recoveryId, segment.sequence_id, segment.speaker ?? '')))
    }
    if (!session.get().notes) restoreLiveNotes()
}

// ---------------------------------------------------------------------------
// Controls

/** ⌘R: Record while idle, Stop while recording; nothing while starting or saving. */
export function toggleRecording() {
    const {phase} = session.get()
    if (phase === 'idle') void startRecording()
    else if (phase === 'recording' || phase === 'paused') void stopRecording()
}

/** The ring: pause or resume. The session follows native's events. */
export async function togglePause() {
    const {phase} = session.get()
    if (phase !== 'recording' && phase !== 'paused') return
    try {
        if (phase === 'recording') await pauseRecording()
        else await resumeRecording()
    } catch (error) {
        toast.error(phase === 'recording' ? 'Could not pause' : 'Could not resume', {description: errorMessage(error)})
    }
}

/**
 * Mutes or turns on one source; computer audio and the microphone are
 * independent. The session follows native's `*-mute-changed` event.
 */
export async function setSourceMuted(source: AudioSource, muted: boolean) {
    try {
        await (source === 'mic' ? setMicrophoneMuted(muted) : setSystemAudioMuted(muted))
    } catch (error) {
        toast.error(source === 'mic' ? 'Could not change the microphone' : 'Could not change computer audio', {
            description: errorMessage(error),
        })
    }
}

/**
 * Records `device` instead of the current one of its kind. On failure the
 * old device keeps recording, and the toast says so.
 */
export async function switchDevice(device: AudioDevice) {
    const kind = device.device_type === 'Input' ? 'Microphone' : 'SystemAudio'
    const what = kind === 'Microphone' ? 'microphone' : 'output'
    try {
        const switched = await attemptDeviceReconnect(device.name, kind)
        if (!switched) throw new Error(`${device.name} is not available.`)
        toast.success(`Recording from ${device.name}`, {id: `switch-${what}`})
        return true
    } catch (error) {
        toast.error(`Could not switch the ${what}`, {
            description: `${errorMessage(error)} The previous ${what} keeps recording.`,
            id: `switch-${what}`,
        })
        return false
    }
}

/**
 * Names a voice on every line of this recording, present and to come.
 * Rejects when the name cannot be stored, so the field stays open.
 */
export async function renameSpeaker(from: string, to: string) {
    const {recoveryId} = session.get()
    const name = to.trim()
    if (!recoveryId || !name || name === from) return
    try {
        storeSpeakerRename(recoveryId, from, name)
    } catch {
        throw new Error('Could not save the name. Try again.')
    }
    renameVoice(from, name)
}

/** The user typed a title: it stays, whatever folder is picked. */
export function renameRecording(title: string) {
    const trimmed = title.trim()
    if (trimmed) session.set({title: trimmed, titleManual: true})
}

/**
 * Files the meeting in `folder` when it is saved. While the title is the
 * automatic one, it follows the folder ("Weekly Standup — Sep 28").
 */
export function setFolder(folder: SessionFolder | null) {
    const {startedAt, titleManual} = session.get()
    session.set({folder})
    if (!startedAt || titleManual) return
    const existing = queries().getQueryData(meetingsQuery.queryKey)?.map((meeting) => meeting.title) ?? []
    session.set({title: automaticTitle(new Date(startedAt), folder?.name, existing)})
}
