import type {NativeLab} from '@/api/labs'
import type {MockHandler} from './handlers'

/** The Labs switches native code keeps in files of their own; all off, as on a new install. Voice profiles are #118's (people). */
export type MockLabs = Record<NativeLab, boolean>

export function createMockLabs(): MockLabs {
    return {whisperSilenceGuard: false, parakeetGpu: false}
}

/**
 * whisper_engine/labs.rs and parakeet_engine/labs.rs. Parakeet on the GPU
 * refuses outside Windows, as native does.
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
    }
}
