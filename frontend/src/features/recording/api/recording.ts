/**
 * The native recorder (src-tauri/src/audio/recording_commands.rs, lib.rs):
 * start, stop, pause and mute, the state it keeps, and the events it emits.
 * Native owns capture and finalization; the WebView starts and stops it,
 * shows it, and saves the meeting once native hands it over with
 * `recording-stop-complete` (save_handoff.rs).
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from '@/api/core'
import type {NativeEvent} from '@/api/events'

/** Mirrors `get_recording_state`. Durations are seconds. */
export interface NativeRecordingState {
    is_recording: boolean
    is_paused: boolean
    is_microphone_muted: boolean
    is_system_audio_muted: boolean
    /** Recording and not paused. */
    is_active: boolean
    /** Since the start, pauses included; null when nothing records. */
    recording_duration: number | null
    /** Since the start, pauses left out: the timer. */
    active_duration: number | null
    total_pause_duration: number
    current_pause_duration: number | null
}

export const isRecording = () => command<boolean>('is_recording')

export const getRecordingState = () => command<NativeRecordingState>('get_recording_state')

export const recordingKeys = {
    all: ['recording'] as const,
    state: () => [...recordingKeys.all, 'state'] as const,
}

/**
 * The recorder's state for a window without the session store: the minibar
 * polls it (features/recording/minibar). The main window keeps its own
 * session instead.
 */
export const recordingStateQuery = queryOptions({
    queryKey: recordingKeys.state(),
    queryFn: getRecordingState,
})

/** The title the running recording started with, after a WebView reload. */
export const getRecordingMeetingName = () => command<string | null>('get_recording_meeting_name')

/**
 * Starts capture: `micDevice` and `systemDevice` are stored device names, or
 * null for the system default (macOS always records the default output).
 * Native checks the speech model first and rejects with its reason; the
 * recording counts as started only on `recording-started`.
 */
export const startRecording = (micDevice: string | null, systemDevice: string | null, title: string) =>
    command<null>('start_recording_with_devices_and_meeting', {
        micDeviceName: micDevice,
        systemDeviceName: systemDevice,
        meetingName: title,
    })

/**
 * Stops capture and finalizes the recording natively; true when this call
 * did it, false when it was already stopping or stopped. `savePath` is
 * required, and native only creates its parent folder (the audio goes in the
 * meeting's folder).
 */
export const stopRecording = (savePath: string) => command<boolean>('stop_recording', {args: {save_path: savePath}})

export const pauseRecording = () => command<null>('pause_recording')

export const resumeRecording = () => command<null>('resume_recording')

/** Mutes or unmutes the microphone while computer audio goes on; resolves to the new state. */
export const setMicrophoneMuted = (muted: boolean) => command<boolean>('set_microphone_muted', {muted})

export const setSystemAudioMuted = (muted: boolean) => command<boolean>('set_system_audio_muted', {muted})

/**
 * Switches a source of the running recording to another device; false (or
 * a rejection) leaves the old device recording.
 */
export const attemptDeviceReconnect = (deviceName: string, deviceType: 'Microphone' | 'SystemAudio') =>
    command<boolean>('attempt_device_reconnect', {deviceName, deviceType})

/** Where recordings are saved, for `stopRecording`'s path (database/commands.rs). */
export const getDatabaseDirectory = () => command<string>('get_database_directory')

/** The running recording's folder, once native has created it. */
export const getMeetingFolderPath = () => command<string | null>('get_meeting_folder_path')

/** Removes a take that was too short to keep (recording_preferences.rs). */
export const discardRecordingFolder = (folderPath: string) => command<null>('discard_recording_folder', {folderPath})

/** Mirrors `TranscriptionStatus`; polled after Stop until the queue is empty. */
export interface TranscriptionStatus {
    chunks_in_queue: number
    is_processing: boolean
    /** Since the last transcription work, ms. */
    last_activity_ms: number
}

export const getTranscriptionStatus = () => command<TranscriptionStatus>('get_transcription_status')

/** How the WebView's save after a native Stop ended (save_handoff.rs). */
export type SaveOutcome = 'saved' | 'discarded' | 'notSaved' | 'failed'

/**
 * Answers the Stop that handed a meeting over. A quit during a recording
 * waits up to 120 s for this answer. Resolves true when Protocol quits once
 * the save is done: then the meeting is not opened, so no post-call pass
 * starts that the exit would cut off.
 */
export const recordingSaveFinished = (stopId: number, outcome: SaveOutcome) =>
    command<boolean>('recording_save_finished', {stopId, outcome})

// ---------------------------------------------------------------------------
// Events

/** The recording runs: the session's start, whatever started it. */
export const RECORDING_STARTED_EVENT = 'recording-started' as NativeEvent<unknown>

/** Capture ended; the folder is final. Every window hears it. */
export interface RecordingStopped {
    message: string
    folder_path?: string | null
    meeting_name?: string | null
    audio_save_error?: string | null
}

export const RECORDING_STOPPED_EVENT = 'recording-stopped' as NativeEvent<RecordingStopped>

export const RECORDING_PAUSED_EVENT = 'recording-paused' as NativeEvent<unknown>
export const RECORDING_RESUMED_EVENT = 'recording-resumed' as NativeEvent<unknown>

/**
 * Native finished stopping and hands the meeting to the main window to save
 * (main window only). Every Stop ends in it: the window's, the tray's, the
 * minibar's and a quit's. `stop_id` is answered with `recordingSaveFinished`.
 */
export interface RecordingStopComplete {
    call_api: boolean
    stop_id?: number | null
    folder_path?: string | null
    meeting_name?: string | null
    /** Some or all audio could not be saved; the transcript is still kept. */
    audio_save_error?: string | null
}

export const RECORDING_STOP_COMPLETE_EVENT = 'recording-stop-complete' as NativeEvent<RecordingStopComplete>

/** Capture failed and the recording stopped; the payload is the reason. */
export const RECORDING_ERROR_EVENT = 'recording-error' as NativeEvent<string>

export interface MuteChanged {
    muted: boolean
}

export const MICROPHONE_MUTE_CHANGED_EVENT = 'microphone-mute-changed' as NativeEvent<MuteChanged>
export const SYSTEM_AUDIO_MUTE_CHANGED_EVENT = 'system-audio-mute-changed' as NativeEvent<MuteChanged>

/**
 * Computer audio is not being captured (Windows routes, a degraded source);
 * main window only. Shown in the app for 30 s: desktop notifications are
 * gone (#126).
 */
export interface AudioRouteWarning {
    title: string
    message: string
}

export const AUDIO_ROUTE_WARNING_EVENT = 'recording-audio-route-warning' as NativeEvent<AudioRouteWarning>

/** Live speaker labels stopped; the transcript keeps its source labels ("You", "Guest"). */
export const LIVE_DIARIZATION_ERROR_EVENT = 'live-diarization-error' as NativeEvent<string>

/**
 * Transcription cannot go on: the recording stops. `actionable` means the
 * speech model needs the user (download it again).
 */
export interface TranscriptionErrorPayload {
    error: string
    userMessage: string
    actionable: boolean
}

export const TRANSCRIPTION_ERROR_EVENT = 'transcription-error' as NativeEvent<TranscriptionErrorPayload>

/** One chunk could not be transcribed; the recording goes on. */
export const TRANSCRIPTION_WARNING_EVENT = 'transcription-warning' as NativeEvent<string>
