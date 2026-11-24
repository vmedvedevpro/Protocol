/**
 * Audio devices and the recording preferences (src-tauri/src/audio/:
 * `get_audio_devices` in lib.rs, recording_preferences.rs). The preferences
 * are one object in the `recording_preferences.json` plugin store, which
 * native code replaces whole on every save; `updateRecordingPreferences` is
 * the only way the UI changes it.
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
    /** Faster live text: shorter pieces and pauses (AI, #117). */
    real_time_transcription: boolean
    /** macOS only, and never shown: native leaves the field out elsewhere. */
    system_audio_backend?: string | null
    /** Record only `per_app_targets` instead of all computer audio (Windows and macOS). */
    per_app_recording_enabled: boolean
    /**
     * The older single-app format. Native keeps it equal to the first target,
     * and re-adds a target from it when the list is empty, so it must be null
     * whenever the list is (`updateRecordingPreferences` does that).
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

// Every update waits for the one before it: two read-modify-writes in flight
// at once would both read the same object, and the second write would undo
// the first (a gain still saving while a device changes).
let queue: Promise<unknown> = Promise.resolve()

/**
 * Changes some preferences and keeps the rest. Native replaces the whole
 * object on save, so the update reads the stored one again just before it
 * writes: fields the UI never shows (`file_format`, `system_audio_backend`)
 * and fields another screen changed go back unchanged. Native also checks the
 * folder is writable and rejects the save if it is not, storing nothing.
 * Resolves with the object it wrote.
 */
export function updateRecordingPreferences(patch: RecordingPreferencesPatch): Promise<RecordingPreferences> {
    const update = queue.then(async () => {
        const stored = await getRecordingPreferences()
        const next: RecordingPreferences = {...stored, ...patch}
        if (patch.per_app_targets) {
            const [first] = patch.per_app_targets
            next.per_app_target_app = first?.executable ?? null
            next.per_app_target_name = first?.name ?? null
        }
        await command<void>('set_recording_preferences', {preferences: next})
        return next
    })
    // A failed update must not stop the ones queued after it.
    queue = update.catch(() => undefined)
    return update
}

/**
 * `updateRecordingPreferences` as a mutation: the cached preferences show the
 * change at once and are read again once it lands, or once it fails.
 */
export const updateRecordingPreferencesMutation = () =>
    mutationOptions({
        mutationFn: updateRecordingPreferences,
        onMutate: async (patch, {client}) => {
            const {queryKey} = recordingPreferencesQuery
            await client.cancelQueries({queryKey})
            client.setQueryData(queryKey, (stored) => (stored ? {...stored, ...patch} : stored))
        },
        onSettled: (_written, _error, _patch, _result, {client}) =>
            client.invalidateQueries({queryKey: deviceKeys.recordingPreferences()}),
    })
