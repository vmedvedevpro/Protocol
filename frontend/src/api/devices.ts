/**
 * Audio devices and the recording preferences (src-tauri/src/audio/:
 * `get_audio_devices` in lib.rs, recording_preferences.rs). The preferences
 * are one object in the `recording_preferences.json` plugin store, which
 * native code replaces whole on every save; `updateRecordingPreferencesMutation`
 * is the only way the UI changes it.
 */
import {mutationOptions, queryOptions} from '@tanstack/react-query'
import {command} from './core'

/** Mirrors `AudioDevice` in audio/devices/configuration.rs. */
export interface AudioDevice {
    name: string
    /** `Output` devices are recorded by loopback: the computer audio. */
    device_type: 'Input' | 'Output'
}

/** Mirrors `PerAppTarget` in recording_preferences.rs. */
export interface PerAppTarget {
    id: string
    name: string
    executable: string
    icon?: string | null
}

/** Mirrors `RecordingPreferences` in recording_preferences.rs. */
export interface RecordingPreferences {
    /** Where each meeting gets its folder; the default folder when nothing is saved. */
    save_folder: string
    /** Save audio: off keeps transcripts only. */
    auto_save: boolean
    /** `mp4`; never shown, written back as read. */
    file_format: string
    /** A stored device (`deviceValue`), or null for the system default. */
    preferred_mic_device: string | null
    preferred_system_device: string | null
    /** Extra gain on the microphone, `MIN_GAIN` to `MAX_GAIN`; native clamps it. */
    mic_gain: number
    system_gain: number
    /**
     * Faster live text (AI, #117; described in #220): live transcription cuts
     * speech at a 350 ms pause and at 3.5 s at most instead of 800 ms and
     * 6 s (`audio/pipeline.rs`), so words come sooner with less context per
     * piece. Only the live pipeline reads it; the post-meeting pass cuts the
     * recording on its own.
     */
    real_time_transcription: boolean
    /** macOS only, and never shown: native leaves the field out elsewhere. */
    system_audio_backend?: string | null
    /** Record only `per_app_targets` instead of all computer audio (Windows and macOS). */
    per_app_recording_enabled: boolean
    /**
     * The older single-app format. Native keeps it equal to the first target,
     * and re-adds a target from it when the list is empty, so it must be null
     * whenever the list is (`updateRecordingPreferencesMutation` does that).
     */
    per_app_target_app: string | null
    per_app_target_name: string | null
    per_app_targets: PerAppTarget[]
}

/** The gain range native code clamps both volumes to. */
export const MIN_GAIN = 0.5
export const MAX_GAIN = 3

/**
 * The string a device is stored and started with: its name and type, as
 * `MacBook Pro Microphone (input)`. Native parses the suffix back
 * (`AudioDevice::from_name`), so the same name as an input and as an output
 * stays two choices.
 */
export function deviceValue(device: AudioDevice): string {
    return `${device.name} (${device.device_type.toLowerCase()})`
}

/** A stored device without its type: `Jabra Evolve2 (input)` → `Jabra Evolve2`. */
export function deviceLabel(stored: string): string {
    return stored.replace(/\s*\((input|output)\)$/i, '')
}

/**
 * The device a recording would open: the saved one while it is connected,
 * else the system default (`device: null`), which native falls back to too
 * (`start_recording` in recording_commands.rs). `missing` names a saved
 * device that is not connected (carried-over settings, an unplugged
 * headset); the preference keeps it, so it is used again once it is back.
 * Until the list is known the saved device counts as connected.
 */
export function deviceInUse(saved: string | null | undefined, devices: readonly AudioDevice[] | undefined): {device: string | null, missing: string | null} {
    if (!saved || !devices || devices.some((device) => deviceValue(device) === saved)) return {device: saved ?? null, missing: null}
    return {device: null, missing: deviceLabel(saved)}
}

export const deviceKeys = {
    all: ['devices'] as const,
    list: () => [...deviceKeys.all, 'list'] as const,
    recordingPreferences: () => [...deviceKeys.all, 'recordingPreferences'] as const,
}

/** Every microphone and output native can open now, in the system's order. */
export const getAudioDevices = () => command<AudioDevice[]>('get_audio_devices')

export const audioDevicesQuery = queryOptions({
    queryKey: deviceKeys.list(),
    queryFn: getAudioDevices,
    // Devices come and go with no event to tell; a screen that lists them
    // reads them again when it opens.
    staleTime: 0,
})

/** Native answers the defaults when nothing is stored or the stored value no longer reads. */
export const getRecordingPreferences = () => command<RecordingPreferences>('get_recording_preferences')

export const recordingPreferencesQuery = queryOptions({
    queryKey: deviceKeys.recordingPreferences(),
    queryFn: getRecordingPreferences,
})

/**
 * What a caller may change. The legacy single-app fields are left out: they
 * follow `per_app_targets`.
 */
export type RecordingPreferencesPatch = Partial<
    Omit<RecordingPreferences, 'per_app_target_app' | 'per_app_target_name'>
>

/**
 * Changes some recording preferences and keeps the rest; the only way the UI
 * changes them. Native replaces the whole object on save, so each update
 * reads the stored one again just before it writes: fields the UI never
 * shows (`file_format`, `system_audio_backend`) and fields another screen
 * changed go back unchanged. Updates share a scope, so they run one at a time:
 * two read-modify-writes at once would both read the same object, and the
 * second write would undo the first. The cached preferences show the change at
 * once and are read again once it lands or fails. Native also checks the
 * folder is writable and rejects the save if it is not, storing nothing.
 */
export const updateRecordingPreferencesMutation = () =>
    mutationOptions({
        mutationFn: async (patch: RecordingPreferencesPatch) => {
            const stored = await getRecordingPreferences()
            const next: RecordingPreferences = {...stored, ...patch}
            if (patch.per_app_targets) {
                const [first] = patch.per_app_targets
                next.per_app_target_app = first?.executable ?? null
                next.per_app_target_name = first?.name ?? null
            }
            await command<void>('set_recording_preferences', {preferences: next})
            return next
        },
        scope: {id: 'recording-preferences'},
        onMutate: async (patch, {client}) => {
            const {queryKey} = recordingPreferencesQuery
            await client.cancelQueries({queryKey})
            client.setQueryData(queryKey, (stored) => (stored ? {...stored, ...patch} : stored))
        },
        onSettled: (_written, _error, _patch, _result, {client}) =>
            client.invalidateQueries({queryKey: deviceKeys.recordingPreferences()}),
    })
