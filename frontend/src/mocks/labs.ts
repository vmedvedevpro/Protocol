import type {NativeLab} from '@/api/labs'
import type {MockHandler} from './handlers'

/** The Labs switches native code keeps in files of their own; all off, as on a new install. */
export type MockLabs = Record<NativeLab, boolean>

export function createMockLabs(): MockLabs {
    return {whisperSilenceGuard: false, parakeetGpu: false, voiceProfiles: false}
}

/**
 * whisper_engine/labs.rs, parakeet_engine/labs.rs and the Voice profiles
 * switch of diarization/voice_profiles.rs. Parakeet on the GPU refuses
 * outside Windows, as native does.
 */
export function labsHandlers(state: {labs: MockLabs, platform: string}): Record<string, MockHandler> {
    return {
        get_whisper_strict_silence: () => state.labs.whisperSilenceGuard,
        set_whisper_strict_silence: ({enabled}) => {
            state.labs.whisperSilenceGuard = Boolean(enabled)
            return null
        },
        get_parakeet_gpu_enabled: () => state.labs.parakeetGpu,
        set_parakeet_gpu_enabled: ({value}) => {
            if (value && state.platform !== 'windows') throw 'Parakeet DirectML acceleration is Windows-only'
            state.labs.parakeetGpu = Boolean(value)
            return null
        },
        get_voice_profiles_enabled: () => state.labs.voiceProfiles,
        set_voice_profiles_enabled: ({value}) => {
            state.labs.voiceProfiles = Boolean(value)
            return null
        },
        // Five minutes of talk and pauses, the same for every recording: the mock audio names no file.
        get_waveform_peaks: () => mockPeaks(),
    }
}

function mockPeaks(): number[] {
    return Array.from({length: 300}, (_, second) => {
        const talk = Math.sin(second / 7) > -0.3 ? 1 : 0.08
        return Math.min(1, talk * (0.35 + 0.4 * Math.abs(Math.sin(second * 1.7)) + 0.2 * Math.abs(Math.sin(second / 3))))
    })
}
