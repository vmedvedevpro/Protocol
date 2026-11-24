import {type AudioDevice, MAX_GAIN, MIN_GAIN, type RecordingPreferences} from '@/api/devices'
import type {Platform} from '@/lib/platform'
import type {MockHandler} from './handlers'

/** What `get_audio_devices` answers and the stored `recording_preferences.json`. */
export interface MockDevices {
    list: AudioDevice[]
    recordingPreferences: RecordingPreferences
}

/** The folder native code falls back to (`get_default_recordings_folder` in recording_preferences.rs). */
export function mockDefaultRecordingsFolder(platform: Platform): string {
    if (platform === 'windows') return 'C:\\Users\\preview\\Music\\protocol-recordings'
    if (platform === 'macos') return '/Users/preview/Movies/protocol-recordings'
    return '/home/preview/Documents/protocol-recordings'
}

/**
 * The old preview's devices (`162e8be:frontend/src/dev/preview/index.ts`),
 * and native's defaults for the preferences: nothing chosen yet. The first
 * microphone and speakers carry the names the fake level feed gives the
 * defaults (`MOCK_MICROPHONE`, `MOCK_SPEAKERS` in src/mocks/audio.ts), spelled
 * out because audio.ts imports the state, which imports this file.
 */
export function createMockDevices(platform: Platform): MockDevices {
    return {
        list: [
            {name: 'MacBook Pro Microphone', device_type: 'Input'},
            {name: 'Studio Display Microphone', device_type: 'Input'},
            // Long enough to be cut short in a select.
            {name: 'Headset Microphone (Jabra Evolve2 65 – Bluetooth Hands-Free)', device_type: 'Input'},
            {name: 'MacBook Pro Speakers', device_type: 'Output'},
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
 * the legacy single-app fields following the first target.
 */
export function devicesHandlers(state: {devices: MockDevices}): Record<string, MockHandler> {
    return {
        get_audio_devices: () => structuredClone(state.devices.list),
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
    }
}
