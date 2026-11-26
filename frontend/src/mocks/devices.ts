import {type AudioDevice, MAX_GAIN, MIN_GAIN, type RecordingPreferences} from '@/api/devices'
import type {Platform} from '@/lib/platform'
import type {MockHandler} from './handlers'

/** What `get_audio_devices` answers and the stored `recording_preferences.json`. */
export interface MockDevices {
    list: AudioDevice[]
    recordingPreferences: RecordingPreferences
    /** What the folder picker answers; null is Cancel. */
    pickedFolder: string | null
    /** Folders `open_recordings_folder` opened, in order, instead of a file manager. */
    openedFolders: string[]
    /** What `get_audio_devices` rejects with instead of the list, as native's error string. */
    listError: string | null
}

/** The default microphone and output, whose levels the fake feed sends (src/mocks/audio.ts). */
export const MOCK_MICROPHONE = 'MacBook Pro Microphone'
export const MOCK_SPEAKERS = 'MacBook Pro Speakers'

/** The folder native code falls back to (`get_default_recordings_folder` in recording_preferences.rs). */
function mockDefaultRecordingsFolder(platform: Platform): string {
    if (platform === 'windows') return 'C:\\Users\\preview\\Music\\protocol-recordings'
    if (platform === 'macos') return '/Users/preview/Movies/protocol-recordings'
    return '/home/preview/Documents/protocol-recordings'
}

/**
 * The old preview's devices (`162e8be:frontend/src/dev/preview/index.ts`),
 * and native's defaults for the preferences: nothing chosen yet.
 */
export function createMockDevices(platform: Platform): MockDevices {
    return {
        pickedFolder: platform === 'windows' ? 'D:\\Meetings' : '/home/preview/Meetings',
        openedFolders: [],
        listError: null,
        list: [
            {name: MOCK_MICROPHONE, device_type: 'Input'},
            {name: 'Studio Display Microphone', device_type: 'Input'},
            // Long enough to be cut short in a select.
            {name: 'Headset Microphone (Jabra Evolve2 65 – Bluetooth Hands-Free)', device_type: 'Input'},
            {name: MOCK_SPEAKERS, device_type: 'Output'},
            {name: 'Studio Display Speakers', device_type: 'Output'},
        ],
        recordingPreferences: {
            save_folder: mockDefaultRecordingsFolder(platform),
            auto_save: true,
            file_format: 'mp4',
            preferred_mic_device: null,
            preferred_system_device: null,
            mic_gain: 1,
            system_gain: 1,
            real_time_transcription: false,
            // Native has the field on macOS only.
            ...(platform === 'macos' ? {system_audio_backend: 'coreaudio'} : {}),
            per_app_recording_enabled: false,
            per_app_target_app: null,
            per_app_target_name: null,
            per_app_targets: [],
        },
    }
}

const clampGain = (gain: number) => Math.min(MAX_GAIN, Math.max(MIN_GAIN, gain))

/**
 * The handlers of `get_audio_devices` (lib.rs) and recording_preferences.rs,
 * spread into `handlers` with the mock state. A save stores the whole object
 * it gets, as native does, after native's own corrections: gains clamped and
 * the legacy single-app fields following the first target. The folder picker
 * answers `pickedFolder` and saves nothing, as native's does.
 */
export function devicesHandlers(state: {devices: MockDevices}): Record<string, MockHandler> {
    return {
        get_audio_devices: () => {
            if (state.devices.listError) throw state.devices.listError
            return structuredClone(state.devices.list)
        },
        get_recording_preferences: () => structuredClone(state.devices.recordingPreferences),
        set_recording_preferences: ({preferences}) => {
            if (preferences === undefined) {
                throw 'invalid args `preferences` for command `set_recording_preferences`: command set_recording_preferences missing required key preferences'
            }
            const next = structuredClone(preferences) as RecordingPreferences
            next.mic_gain = clampGain(next.mic_gain)
            next.system_gain = clampGain(next.system_gain)
            const [first] = next.per_app_targets
            if (first) {
                next.per_app_target_app = first.executable
                next.per_app_target_name = first.name
            } else if (next.per_app_target_app) {
                // Native brings a target back from a stale legacy field.
                const executable = next.per_app_target_app
                next.per_app_targets = [{id: executable, name: next.per_app_target_name ?? executable, executable}]
            }
            state.devices.recordingPreferences = next
            return null
        },
        select_recording_folder: () => state.devices.pickedFolder,
        open_recordings_folder: () => {
            state.devices.openedFolders.push(state.devices.recordingPreferences.save_folder)
            return null
        },
    }
}
