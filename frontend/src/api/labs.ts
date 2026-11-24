/**
 * Labs: experiments the user turns on in Settings › Advanced. Two of them
 * live only in the WebView, in localStorage `meetily-labs-v1` (PARITY.md,
 * Keep reading): Waveform scrubbing (the meeting's player) and Clean
 * transcript (the meeting's transcript and its summary). Three are native
 * switches, each in a file of its own: the Whisper silence guard
 * (whisper_engine/labs.rs), Voice profiles (diarization/voice_profiles.rs)
 * and Parakeet on the GPU (parakeet_engine/labs.rs, Windows). Native is the
 * truth for those, read with Query; the old app mirrored them into the same
 * localStorage object, and a change here keeps that mirror, so the stored
 * object stays the shape the old app wrote.
 */
import {mutationOptions, queryOptions} from '@tanstack/react-query'
import {create} from 'zustand'
import {persist, type PersistStorage} from 'zustand/middleware'
import {safely} from '@/lib/storage'
import {command} from './core'

// --- The stored switches -----------------------------------------------------

/**
 * The old app's object, every field kept. `meetingAutomation` belonged to
 * meeting detection, which is gone: it is read and written back unchanged.
 */
export interface LabsPreferences {
    meetingAutomation: boolean
    /** Waveform scrubbing. */
    transcriptScrubbing: boolean
    voiceProfiles: boolean
    whisperSilenceGuard: boolean
    cleanTranscript: boolean
    parakeetGpu: boolean
}

export const LABS_KEY = 'meetily-labs-v1'

export const DEFAULT_LABS: LabsPreferences = {
    meetingAutomation: false,
    transcriptScrubbing: false,
    voiceProfiles: false,
    whisperSilenceGuard: false,
    cleanTranscript: false,
    parakeetGpu: false,
}

/** What the old `loadLabsPreferences` read: each boolean field, the default for anything else. */
export function readLabs(stored: string | null): LabsPreferences {
    const saved: unknown = stored ? safely(() => JSON.parse(stored)) : null
    const record = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {}
    const labs = {...DEFAULT_LABS}
    for (const name of Object.keys(DEFAULT_LABS) as (keyof LabsPreferences)[]) {
        const value = record[name]
        if (typeof value === 'boolean') labs[name] = value
    }
    return labs
}

interface LabsStore {
    labs: LabsPreferences
    setLab: (name: keyof LabsPreferences, on: boolean) => void
}

// The old format: the bare object, never Zustand's `{state, version}`.
const labsStorage: PersistStorage<Pick<LabsStore, 'labs'>> = {
    getItem: (name) => ({state: {labs: readLabs(safely(() => localStorage.getItem(name)))}, version: 0}),
    setItem: (name, {state}) => {
        safely(() => localStorage.setItem(name, JSON.stringify(state.labs)))
    },
    removeItem: (name) => {
        safely(() => localStorage.removeItem(name))
    },
}

/**
 * The stored object. Turn Waveform scrubbing and Clean transcript on and off
 * with `setLab`; the native three change through `setNativeLabMutation`,
 * which mirrors them here once native has taken the change.
 */
export const useLabsStore = create<LabsStore>()(
    persist(
        (set) => ({
            labs: DEFAULT_LABS,
            setLab: (name, on) => set(({labs}) => ({labs: {...labs, [name]: on}})),
        }),
        {name: LABS_KEY, storage: labsStorage, partialize: ({labs}) => ({labs})},
    ),
)

/** Whether one stored switch is on. */
export const useLab = (name: 'transcriptScrubbing' | 'cleanTranscript') => useLabsStore((state) => state.labs[name])

// --- The native switches -----------------------------------------------------

export type NativeLab = 'whisperSilenceGuard' | 'voiceProfiles' | 'parakeetGpu'

/**
 * Each switch's commands. Parakeet on the GPU reloads the current Parakeet
 * model before it answers, and native puts the processor back and rejects
 * when that fails, so a rejection means nothing changed; it rejects on
 * anything but Windows.
 */
const NATIVE_LABS: Record<NativeLab, {get: string, set: (on: boolean) => Promise<unknown>}> = {
    whisperSilenceGuard: {
        get: 'get_whisper_strict_silence',
        set: (enabled) => command<null>('set_whisper_strict_silence', {enabled}),
    },
    voiceProfiles: {
        get: 'get_voice_profiles_enabled',
        set: (value) => command<null>('set_voice_profiles_enabled', {value}),
    },
    parakeetGpu: {
        get: 'get_parakeet_gpu_enabled',
        set: (value) => command<null>('set_parakeet_gpu_enabled', {value}),
    },
}

export const getNativeLab = (lab: NativeLab) => command<boolean>(NATIVE_LABS[lab].get)

export const setNativeLab = (lab: NativeLab, on: boolean) => NATIVE_LABS[lab].set(on)

export const labsKeys = {
    all: ['labs'] as const,
    native: (lab: NativeLab) => [...labsKeys.all, 'native', lab] as const,
}

export const nativeLabQuery = (lab: NativeLab) => queryOptions({
    queryKey: labsKeys.native(lab),
    queryFn: () => getNativeLab(lab),
})

/**
 * Turns a native switch on or off. The switch shows the choice at once and
 * is read again once native answers; the localStorage mirror follows only a
 * change native took.
 */
export const setNativeLabMutation = () =>
    mutationOptions({
        mutationFn: async ({lab, on}: {lab: NativeLab, on: boolean}) => {
            await setNativeLab(lab, on)
        },
        scope: {id: 'native-labs'},
        onMutate: async ({lab, on}, {client}) => {
            const {queryKey} = nativeLabQuery(lab)
            await client.cancelQueries({queryKey})
            client.setQueryData(queryKey, on)
        },
        onSuccess: (_reply, {lab, on}) => useLabsStore.getState().setLab(lab, on),
        onSettled: (_reply, _error, {lab}, _result, {client}) =>
            client.invalidateQueries({queryKey: labsKeys.native(lab)}),
    })
