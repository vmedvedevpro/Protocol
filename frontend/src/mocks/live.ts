import {emit} from '@tauri-apps/api/event'
import type {NativeEvent} from '@/api/events'
import type {AudioRecovery} from '@/features/recording/api/recovery'
import type {
    NativeRecordingState,
    RecordingStopComplete,
    RecordingStopped,
    SaveOutcome,
    TranscriptionStatus,
} from '@/features/recording/api/recording'
import type {TranscriptHistorySegment, TranscriptUpdate} from '@/features/recording/api/transcript'
import type {MockArgs, MockHandler} from './handlers'
import type {MockState} from './state'

/**
 * The recorder (#112), ported from the old preview (`162e8be`,
 * frontend/src/dev/preview/live.ts): a start emits `recording-started`, then
 * in `pnpm dev` and Storybook a line of the script every few seconds; pause
 * and mute behave as native does, and Stop hands the meeting over with
 * `recording-stop-complete`, so the real save runs into the sample library.
 * Tests speak lines with `speakMockLine` instead of the timer.
 */

const SCRIPT: readonly (readonly [string, string])[] = [
    ['You', 'Morning everyone, let’s keep this one short.'],
    ['Speaker 2', 'Sure. Yesterday I finished the export dialog and started on moving meetings between groups.'],
    ['Speaker 3', 'I’m still on the onboarding copy. Design review is Thursday at noon.'],
    ['You', 'Great. Any blockers?'],
    ['Speaker 2', 'The audio route warning fires twice on some headsets. I need a Windows machine with a USB headset to check it.'],
    ['You', 'I have one. I’ll send it over after this call.'],
    ['Speaker 3', 'Can we decide on the default theme before the release notes go out?'],
    ['You', 'Let’s keep Midnight as the default and mention Vanilla and Charcoal in the notes.'],
    ['Speaker 2', 'Works for me. I’ll write that section of the release notes by Friday.'],
    ['Speaker 3', 'Then I think that covers it.'],
]

// A line of the script every so often while recording, outside tests.
const SPEAK_EVERY_MS = 2_600
const LINE_SECONDS = 2.4

export interface MockRecording {
    meetingName: string
    folderPath: string
    micDevice: string | null
    systemDevice: string | null
    startedAt: number
    pausedAt: number | null
    pausedMs: number
    micMuted: boolean
    systemMuted: boolean
    lines: TranscriptHistorySegment[]
}

export function createMockLive() {
    return {
        /** The running recording, null while none runs. */
        recording: null as MockRecording | null,
        /** `check_transcription_runtime` rejects with it. */
        runtimeError: null as string | null,
        /** The next start rejects with it, as native does for a device it cannot open. */
        startError: null as string | null,
        loaded: {parakeet: false, whisper: false},
        /** Why Whisper stays off the graphics card (Linux crash guard); `whisper_gpu_retry` clears it. */
        gpuStopped: null as string | null,
        /** What `get_transcription_status` answers after a Stop. */
        transcription: {chunks_in_queue: 0, is_processing: false, last_activity_ms: 60_000} as TranscriptionStatus,
        /** Native says the app quits after the save (`recording_save_finished`). */
        quitting: false,
        nextStopId: 1,
        /** Every answer to a Stop, in order. */
        saveAnswers: [] as { stopId: number, outcome: SaveOutcome }[],
        /** Folders `discard_recording_folder` removed. */
        discarded: [] as string[],
        /** Recording folders that hold audio checkpoints, for recovery. */
        checkpoints: {} as Record<string, boolean>,
        /** What `updater_set_ui_activity` was last told. */
        uiActivity: [] as string[],
        /** Devices `attempt_device_reconnect` switched to. */
        reconnected: [] as string[],
        /** The answer of "Summarize so far". */
        assistantAnswer: '**So far**\n\n- The export dialog is done; moving meetings between groups is next.\n- Design review is Thursday at noon.\n\n**Action items**\n\n- You: send the USB headset over.\n- Speaker 2: release notes section by Friday.',
    }
}

export type MockLive = ReturnType<typeof createMockLive>

// Events go out after the command's reply, as native emits from its own task.
const later = <T, >(event: NativeEvent<T>, payload: T) => void Promise.resolve().then(() => emit(event, payload))

function activeSeconds(recording: MockRecording, now = Date.now()): number {
    const end = recording.pausedAt ?? now
    return Math.max(0, (end - recording.startedAt - recording.pausedMs) / 1000)
}

function recordingState(recording: MockRecording | null): NativeRecordingState {
    const now = Date.now()
    return {
        is_recording: !!recording,
        is_paused: !!recording?.pausedAt,
        is_microphone_muted: recording?.micMuted ?? false,
        is_system_audio_muted: recording?.systemMuted ?? false,
        is_active: !!recording && !recording.pausedAt,
        recording_duration: recording ? (now - recording.startedAt) / 1000 : null,
        active_duration: recording ? activeSeconds(recording, now) : null,
        total_pause_duration: recording ? recording.pausedMs / 1000 : 0,
        current_pause_duration: recording?.pausedAt ? (now - recording.pausedAt) / 1000 : null,
    }
}

/**
 * The next line of the script, as live transcription emits it; false when
 * nothing records, it is paused, or the line's source is muted.
 */
export function speakMockLine(state: MockState): boolean {
    const recording = state.live.recording
    if (!recording || recording.pausedAt) return false
    const [speaker, text] = SCRIPT[recording.lines.length % SCRIPT.length]
    if (speaker === 'You' ? recording.micMuted : recording.systemMuted) return false
    const sequence = recording.lines.length + 1
    const start = Math.max(0, activeSeconds(recording) - LINE_SECONDS)
    const update: TranscriptUpdate = {
        text,
        timestamp: new Date().toLocaleTimeString('en-GB'),
        source: speaker,
        sequence_id: sequence,
        chunk_start_time: start,
        is_partial: false,
        confidence: 0.93,
        audio_start_time: start,
        audio_end_time: start + LINE_SECONDS,
        duration: LINE_SECONDS,
    }
    recording.lines.push({
        id: `live-${sequence}`,
        text,
        audio_start_time: start,
        audio_end_time: start + LINE_SECONDS,
        duration: LINE_SECONDS,
        display_time: `[${String(Math.floor(start / 60)).padStart(2, '0')}:${String(Math.floor(start % 60)).padStart(2, '0')}]`,
        confidence: 0.93,
        sequence_id: sequence,
        speaker,
    })
    later('transcript-update' as NativeEvent<TranscriptUpdate>, update)
    return true
}

// The timer belongs to one recording: a reset or a Stop replaces it, and it ends.
function speakWhileRecording(state: MockState, recording: MockRecording) {
    if (import.meta.env.MODE === 'test') return
    const timer = setInterval(() => {
        if (state.live.recording !== recording) {
            clearInterval(timer)
            return
        }
        if (!document.hidden) speakMockLine(state)
    }, SPEAK_EVERY_MS)
}

const folderName = (title: string, at: Date) =>
    `${title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '_') || 'Meeting'}_${at.toISOString().slice(0, 19).replace(/[:T]/g, '-')}`

/** src-tauri/src/audio/recording_commands.rs, lib.rs, save_handoff.rs, live_assistant.rs */
export function liveHandlers(state: MockState): Record<string, MockHandler> {
    const live = () => state.live
    const running = (command: string) => {
        const recording = live().recording
        if (!recording) throw `No recording in progress (${command})`
        return recording
    }

    return {
        is_recording: () => !!live().recording,
        get_recording_state: () => recordingState(live().recording),
        get_recording_meeting_name: () => live().recording?.meetingName ?? null,
        get_meeting_folder_path: () => live().recording?.folderPath ?? null,
        get_transcript_history: () => live().recording?.lines.map((line) => ({...line})) ?? [],
        start_recording_with_devices_and_meeting: ({micDeviceName, systemDeviceName, meetingName}: MockArgs) => {
            if (live().recording) throw 'Recording already in progress'
            if (live().startError) throw live().startError
            const startedAt = Date.now()
            const title = typeof meetingName === 'string' && meetingName ? meetingName : 'Meeting'
            const recording: MockRecording = {
                meetingName: title,
                folderPath: `${state.devices.recordingPreferences.save_folder}/${folderName(title, new Date(startedAt))}`,
                micDevice: typeof micDeviceName === 'string' ? micDeviceName : null,
                systemDevice: typeof systemDeviceName === 'string' ? systemDeviceName : null,
                startedAt,
                pausedAt: null,
                pausedMs: 0,
                micMuted: false,
                systemMuted: false,
                lines: [],
            }
            live().recording = recording
            later('recording-started' as NativeEvent<null>, null)
            speakWhileRecording(state, recording)
            return null
        },
        stop_recording: ({args}: MockArgs) => {
            if (typeof (args as { save_path?: unknown } | undefined)?.save_path !== 'string') {
                throw 'invalid args `args` for command `stop_recording`: missing field `save_path`'
            }
            const recording = live().recording
            if (!recording) return false
            live().recording = null
            const stopId = live().nextStopId++
            const stopped: RecordingStopped = {message: 'Recording stopped', folder_path: recording.folderPath, meeting_name: recording.meetingName}
            const complete: RecordingStopComplete = {
                call_api: true,
                stop_id: stopId,
                folder_path: recording.folderPath,
                meeting_name: recording.meetingName,
                audio_save_error: null,
            }
            later('recording-stopped' as NativeEvent<RecordingStopped>, stopped)
            later('recording-stop-complete' as NativeEvent<RecordingStopComplete>, complete)
            return true
        },
        pause_recording: () => {
            const recording = running('pause_recording')
            if (!recording.pausedAt) {
                recording.pausedAt = Date.now()
                later('recording-paused' as NativeEvent<null>, null)
            }
            return null
        },
        resume_recording: () => {
            const recording = running('resume_recording')
            if (recording.pausedAt) {
                recording.pausedMs += Date.now() - recording.pausedAt
                recording.pausedAt = null
                later('recording-resumed' as NativeEvent<null>, null)
            }
            return null
        },
        set_microphone_muted: ({muted}: MockArgs) => {
            const recording = running('set_microphone_muted')
            recording.micMuted = !!muted
            later('microphone-mute-changed' as NativeEvent<{ muted: boolean }>, {muted: recording.micMuted})
            return recording.micMuted
        },
        set_system_audio_muted: ({muted}: MockArgs) => {
            const recording = running('set_system_audio_muted')
            recording.systemMuted = !!muted
            later('system-audio-mute-changed' as NativeEvent<{ muted: boolean }>, {muted: recording.systemMuted})
            return recording.systemMuted
        },
        attempt_device_reconnect: ({deviceName, deviceType}: MockArgs) => {
            const recording = running('attempt_device_reconnect')
            if (deviceType !== 'Microphone' && deviceType !== 'SystemAudio') throw `Invalid device type: ${String(deviceType)}`
            const kind = deviceType === 'Microphone' ? 'Input' : 'Output'
            const device = state.devices.list.find((entry) => entry.name === deviceName && entry.device_type === kind)
            if (!device) return false
            if (kind === 'Input') recording.micDevice = device.name
            else recording.systemDevice = device.name
            live().reconnected.push(device.name)
            return true
        },
        get_database_directory: () => '/home/user/.local/share/protocol',
        discard_recording_folder: ({folderPath}: MockArgs) => {
            live().discarded.push(String(folderPath))
            return null
        },
        get_transcription_status: () => ({...live().transcription}),
        recording_save_finished: ({stopId, outcome}: MockArgs) => {
            live().saveAnswers.push({stopId: Number(stopId), outcome: outcome as SaveOutcome})
            return live().quitting
        },

        // Speech runtime and the live model (lib.rs, whisper_engine, parakeet_engine)
        check_transcription_runtime: () => {
            if (live().runtimeError) throw live().runtimeError
            return null
        },
        parakeet_has_available_models: () => state.models.parakeet === 'Available',
        parakeet_is_model_loaded: () => live().loaded.parakeet,
        parakeet_load_model: () => {
            if (state.models.parakeet !== 'Available') throw 'Parakeet model not found'
            live().loaded.parakeet = true
            return null
        },
        whisper_has_available_models: () => Object.values(state.models.whisper).some((status) => status === 'Available'),
        whisper_is_model_loaded: () => live().loaded.whisper,
        whisper_load_model: ({modelName}: MockArgs) => {
            if (state.models.whisper[String(modelName)] !== 'Available') throw `Model ${String(modelName)} is not downloaded`
            live().loaded.whisper = true
            return null
        },

        // Transcript recovery: audio checkpoints of an interrupted recording
        has_audio_checkpoints: ({meetingFolder}: MockArgs) => !!live().checkpoints[String(meetingFolder)],
        recover_audio_from_checkpoints: ({meetingFolder}: MockArgs): AudioRecovery => {
            const folder = String(meetingFolder)
            if (!live().checkpoints[folder]) {
                return {status: 'none', chunk_count: 0, estimated_duration_seconds: 0, audio_file_path: null, message: 'No checkpoints found'}
            }
            return {status: 'success', chunk_count: 12, estimated_duration_seconds: 360, audio_file_path: `${folder}/audio.mp4`, message: 'Audio recovered'}
        },
        cleanup_checkpoints: ({meetingFolder}: MockArgs) => {
            delete live().checkpoints[String(meetingFolder)]
            return null
        },

        // updater/commands.rs: the WebView's own work, which holds off an install
        updater_set_ui_activity: ({activities}: MockArgs) => {
            const list = Array.isArray(activities) ? activities.map(String) : []
            const unknown = list.find((name) => name !== 'recordingSave' && name !== 'postCall')
            if (unknown) throw `unknown variant \`${unknown}\`, expected \`recordingSave\` or \`postCall\``
            live().uiActivity = list
            return null
        },

        // live_assistant.rs: "Summarize so far"
        ask_live_assistant: async ({question, transcriptContext}: MockArgs) => {
            if (!String(question ?? '').trim()) throw 'Ask a question first.'
            if (!String(transcriptContext ?? '').trim()) throw 'There is no transcript yet.'
            await new Promise((resolve) => setTimeout(resolve, import.meta.env.MODE === 'test' ? 0 : 1_200))
            return live().assistantAnswer
        },
    }
}
