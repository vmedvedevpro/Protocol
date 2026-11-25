/**
 * What is loaded on this computer now (`get_local_stack_status`,
 * whisper_engine/commands.rs), and the two ways to free memory. Settings ›
 * Advanced › Local AI reads it every 5 s while it shows, as the old page did:
 * native sends no event when a model loads or unloads.
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from './core'

export interface LocalStackStatus {
    /** A recording runs: nothing may be unloaded. */
    recording: boolean
    whisper: {
        loaded: boolean
        model: string | null
        /** Windows: the device the Intel GPU version runs on, or why its last load fell back. */
        openvino?: {device: string | null, fallbackReason: string | null} | null
    }
    parakeet: {loaded: boolean, model: string | null, backend: 'CPU' | 'DirectML'}
    sttIdleUnloadSecs: number
    llmIdleUnloadSecs: number
    sttLastUnloadSecs?: number | null
    llmLastUnloadSecs?: number | null
    modelsDirBytes?: number
    dataDirBytes?: number
    modelsDir?: string
    vramHintMb?: number
    cuda?: boolean
    vulkan?: boolean
    /** How this build runs Whisper: `cpu`, `vulkan`, `cuda`, `metal`, `hipblas`. */
    sttBackend?: string
    networkPolicy?: string
    networkNote?: string
}

export const getLocalStackStatus = () => command<LocalStackStatus>('get_local_stack_status')

/** Unloads Parakeet and Whisper; refused during a recording. */
export const unloadSpeechModels = () => command<null>('force_unload_stt_models')

/** Unloads the speech models and the built-in summary model; refused during a recording. */
export const freeAllMemory = () => command<null>('force_unload_all_models')

export const localStackKeys = {
    all: ['localStack'] as const,
    status: () => [...localStackKeys.all, 'status'] as const,
}

/** The status, read every `LOCAL_STACK_POLL_MS` while a screen shows it. */
export const LOCAL_STACK_POLL_MS = 5000

export const localStackQuery = queryOptions({
    queryKey: localStackKeys.status(),
    queryFn: getLocalStackStatus,
})

/** Why the Intel GPU version fell back in this run, unless it runs now. */
export const gpuFallbackReason = (status: LocalStackStatus | undefined) =>
    status?.whisper.openvino?.device ? null : status?.whisper.openvino?.fallbackReason ?? null

/** Where Whisper runs, in the UI's words. */
export function whisperDevice(status: LocalStackStatus | undefined): string | null {
    if (!status) return null
    if (status.whisper.openvino?.device) return 'Intel GPU'
    switch (status.sttBackend?.trim().toLowerCase()) {
        case 'cuda':
            return 'NVIDIA GPU'
        case 'vulkan':
            return 'graphics card'
        case 'metal':
            return 'Apple GPU'
        case 'hipblas':
        case 'hip blas':
            return 'AMD GPU'
        default:
            return status.cuda ? 'NVIDIA GPU' : status.vulkan ? 'graphics card' : 'processor'
    }
}
