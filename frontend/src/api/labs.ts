/**
 * Labs: experiments the user turns on in Settings › Advanced. Two of them
 * live only in the WebView, in localStorage `meetily-labs-v1` (PARITY.md,
 * Keep reading): Waveform scrubbing (the meeting's player) and Clean
 * transcript (the meeting's transcript and its summary). Two are native
 * switches, each in a file of its own and read with Query: the Whisper
 * silence guard (whisper_engine/labs.rs) and Parakeet on the GPU
 * (parakeet_engine/labs.rs, Windows). The third native switch, Voice
 * profiles, belongs to the people domain (`src/api/people.ts`, #118), since
 * the voices it learns are people's.
 *
 * The old app also mirrored the native switches into the stored object.
 * Nothing reads that copy now: the object keeps the fields it holds, as it
 * holds them, and only the two WebView switches change in it.
 */
import {mutationOptions, queryOptions} from '@tanstack/react-query'
import {safely, storedValue} from '@/lib/storage'
import {command} from './core'

// --- The stored switches -----------------------------------------------------

/**
 * The old app's object, every field kept. `meetingAutomation` belonged to
 * meeting detection, which is gone; it and the old mirrors of the native
 * switches are read and written back unchanged.
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

/** The switches that live only here. */
export type WebViewLab = 'transcriptScrubbing' | 'cleanTranscript'

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

/** The stored object, in the old format: the bare object, never Zustand's `{state, version}`. */
export const useLabsStore = storedValue(LABS_KEY, readLabs, (labs) => JSON.stringify(labs))

/** Whether one WebView switch is on. */
export const useLab = (name: WebViewLab) => useLabsStore((state) => state.value[name])

/** Turns a WebView switch on or off, keeping the other fields. */
export function setLab(name: WebViewLab, on: boolean) {
    const {value, set} = useLabsStore.getState()
    set({...value, [name]: on})
}

// --- The native switches -----------------------------------------------------

export type NativeLab = 'whisperSilenceGuard' | 'parakeetGpu'

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

/** Turns a native switch on or off; the switch shows the choice at once and is read again once native answers. */
export const setNativeLabMutation = () =>
    mutationOptions({
        mutationFn: ({lab, on}: {lab: NativeLab, on: boolean}) => setNativeLab(lab, on),
        scope: {id: 'native-labs'},
        onMutate: async ({lab, on}, {client}) => {
            const {queryKey} = nativeLabQuery(lab)
            await client.cancelQueries({queryKey})
            client.setQueryData(queryKey, on)
        },
        onSettled: (_reply, _error, {lab}, _result, {client}) =>
            client.invalidateQueries({queryKey: labsKeys.native(lab)}),
    })
