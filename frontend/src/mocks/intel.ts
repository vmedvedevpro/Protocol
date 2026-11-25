import {emit} from '@tauri-apps/api/event'
import type {NativeEvent} from '@/api/events'
import {
    type CompanionStatus,
    GPU_VERSION_OF,
    INTEL_CANCELLED,
    INTEL_LIBRARIES_ID,
    NPU_STATUS_EVENT,
    type NpuState,
    OPENVINO_COMPANION_CHANGED_EVENT,
    OPENVINO_RUNTIME_PROGRESS_EVENT,
    type OpenVinoAvailability,
    type ParakeetNpuStatus,
} from '@/api/intel'
import type {WhisperModelInfo} from '@/api/models'
import {POST_CALL_TRANSCRIPT_CONFIG_CHANGED_EVENT} from '@/api/speech'
import type {MockHandler} from './handlers'
import type {MockSpeech} from './speech'

/**
 * Intel GPU and NPU states, ported from the old preview
 * (`162e8be:frontend/src/dev/preview/intel.ts`): the Intel GPU version of
 * Whisper Large V3 Turbo, Intel's libraries and the NPU. A computer without
 * either by default; `?intel=gpu`, `?intel=npu` or `?intel=gpu,npu` in pnpm
 * dev gives them (with `?platform=windows`, where the commands exist).
 */

export const GPU_VERSION_ID = 'large-v3-turbo-openvino-int8'
const MB = 1024 * 1024
const COMPANION_BYTES = 828 * MB
const RUNTIME_BYTES = 254 * MB
const TICK_MS = 250

export interface MockIntel {
    /** The GPU whisper.cpp uses is an Intel GPU. */
    gpu: boolean
    npu: boolean
    gpuInstalled: boolean
    runtimeInstalled: boolean
    /** The Intel GPU version's download, percent. */
    downloading: number | null
    /** Intel's libraries downloading alone. */
    librariesDownloading: boolean
    /** The crash guard turned the Intel GPU version off. */
    stopped: string | null
    npuState: NpuState
    /** Percent a fake download gains each tick. */
    downloadStep: number
    /** `openvino_download` with `choose` saved the version as the after-meeting model. */
    chosen: boolean
    /** Linux: the sentence naming Intel's GPU driver still to install (#178). */
    driver: string | null
}

export function createMockIntel(): MockIntel {
    const hardware = new URLSearchParams(window.location.search).get('intel') ?? ''
    return {
        gpu: hardware.includes('gpu'),
        npu: hardware.includes('npu'),
        gpuInstalled: false,
        runtimeInstalled: false,
        downloading: null,
        librariesDownloading: false,
        stopped: null,
        npuState: 'needs_runtime',
        downloadStep: 10,
        chosen: false,
        driver: null,
    }
}

const send = <T, >(event: NativeEvent<T>, payload: T) => void emit(event, payload).catch(() => undefined)

/** The Whisper list's row for an installed Intel GPU version (`speech_choice::listed`). */
export function gpuVersionRow(intel: MockIntel): WhisperModelInfo | null {
    if (!intel.gpuInstalled || !intel.runtimeInstalled) return null
    return {
        name: GPU_VERSION_ID,
        path: `models/openvino/${GPU_VERSION_ID}`,
        size_bytes: COMPANION_BYTES,
        accuracy: 'High',
        speed: 'Medium',
        status: 'Available',
        description: 'Large V3 Turbo for Intel GPUs',
        display_name: 'Large V3 Turbo',
        tier: null,
        recommended: false,
        languages: ['*'],
        companion_of: ['large-v3-turbo', GPU_VERSION_OF],
    }
}

function npuStatus(intel: MockIntel): ParakeetNpuStatus {
    if (!intel.npu) return {present: false, state: 'absent', active: false, reason: null}
    const state = intel.npuState === 'needs_runtime' && intel.runtimeInstalled ? 'ready' : intel.npuState
    return {present: true, state, active: state === 'ready', reason: state === 'failed' ? 'NPU compile failed' : null}
}

function companion(intel: MockIntel): CompanionStatus {
    const downloadSize = (intel.gpuInstalled ? 0 : COMPANION_BYTES) + (intel.runtimeInstalled ? 0 : RUNTIME_BYTES)
    const total = COMPANION_BYTES + RUNTIME_BYTES
    return {
        id: GPU_VERSION_ID,
        name: 'Large V3 Turbo for Intel GPUs',
        description: 'Runs on an Intel GPU instead of the Large V3 Turbo models',
        repo: 'OpenVINO/whisper-large-v3-turbo-int8-ov',
        companionOf: ['large-v3-turbo', GPU_VERSION_OF],
        size: COMPANION_BYTES,
        companionInstalled: intel.gpuInstalled,
        runtime: {
            name: 'OpenVINO GenAI',
            version: '2026.4.1.0',
            license: {name: 'Intel OpenVINO Distribution License', url: 'https://www.intel.com'},
            source: 'storage.openvinotoolkit.org',
            downloadSize: RUNTIME_BYTES,
            installedSize: 111 * MB,
            installed: intel.runtimeInstalled ? '2026.4.1.0' : null,
            afterRestart: null,
            removedAtRestart: null,
        },
        installed: intel.gpuInstalled && intel.runtimeInstalled,
        downloadSize: downloadSize || null,
        refused: null,
        downloading: intel.downloading,
        progress: intel.downloading === null ? null : {done: (total * intel.downloading) / 100, total},
        stopped: intel.stopped,
        removesRuntime: !intel.npu,
    }
}

// The running fake downloads, by `openvino_cancel` id.
const cancels = new Map<string, () => void>()

function fakeDownload(intel: MockIntel, id: string, onTick: (percent: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        let percent = 0
        const timer = setInterval(() => {
            percent = Math.min(100, percent + intel.downloadStep)
            if (percent < 100) return onTick(percent)
            clearInterval(timer)
            cancels.delete(id)
            resolve()
        }, TICK_MS)
        cancels.set(id, () => {
            clearInterval(timer)
            cancels.delete(id)
            reject(INTEL_CANCELLED)
        })
    })
}

/** `get_openvino_availability` answers everywhere; outside Windows and Linux native says it does not run. */
export function intelHandlers(state: {intel: MockIntel, platform: string}): Record<string, MockHandler> {
    return {
        get_openvino_availability: (): OpenVinoAvailability => state.platform !== 'windows' && state.platform !== 'linux'
            ? {reason: 'OpenVINO runs only in the Windows and Linux apps', device: null}
            : {
                offer: state.intel.gpu,
                gpu: state.intel.gpu ? 'Intel(R) Arc(TM) Graphics' : null,
                reason: state.intel.gpu ? null : 'The GPU is not an Intel GPU',
                device: state.intel.gpu && state.intel.runtimeInstalled ? 'GPU' : null,
                mismatch: null,
                driver: state.platform === 'linux' && state.intel.gpu ? state.intel.driver : null,
            },
    }
}

/** model_catalog/openvino.rs, parakeet_engine/npu/state.rs and speech_choice.rs: Windows only. */
export function windowsIntelHandlers(state: {intel: MockIntel, speech: MockSpeech}): Record<string, MockHandler> {
    const intel = () => state.intel
    const changed = () => send(OPENVINO_COMPANION_CHANGED_EVENT, null)
    return {
        openvino_status: ({whisperModel}) => (String(whisperModel) === GPU_VERSION_OF ? companion(intel()) : null),
        openvino_download: async ({id, choose}) => {
            if (String(id) !== GPU_VERSION_ID) throw `${String(id)} is not in the model list`
            if (intel().downloading !== null) throw 'The Intel GPU version is already downloading'
            intel().downloading = 0
            changed()
            try {
                await fakeDownload(intel(), GPU_VERSION_ID, (percent) => {
                    intel().downloading = percent
                    changed()
                })
            } finally {
                intel().downloading = null
            }
            intel().gpuInstalled = true
            intel().runtimeInstalled = true
            if (choose) {
                // Native saves it as the after-meeting model before it answers.
                intel().chosen = true
                state.speech.postCallConfig = {provider: 'whisper', model: GPU_VERSION_ID}
                send(POST_CALL_TRANSCRIPT_CONFIG_CHANGED_EVENT, null)
            }
            changed()
            send(NPU_STATUS_EVENT, npuStatus(intel()))
            return null
        },
        openvino_runtime_download: async () => {
            if (intel().librariesDownloading) throw "Intel's libraries are already downloading"
            intel().librariesDownloading = true
            try {
                await fakeDownload(intel(), INTEL_LIBRARIES_ID, (percent) => {
                    send(OPENVINO_RUNTIME_PROGRESS_EVENT, {done: (RUNTIME_BYTES * percent) / 100, total: RUNTIME_BYTES})
                    changed()
                })
            } finally {
                intel().librariesDownloading = false
            }
            intel().runtimeInstalled = true
            changed()
            send(NPU_STATUS_EVENT, npuStatus(intel()))
            return null
        },
        openvino_cancel: ({id}) => {
            cancels.get(String(id))?.()
            return null
        },
        openvino_retry: () => {
            intel().stopped = null
            changed()
            return null
        },
        parakeet_npu_status: () => npuStatus(intel()),
        parakeet_npu_retry: () => {
            intel().npuState = 'ready'
            const status = npuStatus(intel())
            send(NPU_STATUS_EVENT, status)
            return status
        },
        speech_choice_copy_retires: () => false,
        speech_choice_remove_gpu_version: ({id}) => {
            if (String(id) !== GPU_VERSION_ID) throw `${String(id)} is not in the model list`
            intel().gpuInstalled = false
            intel().chosen = false
            if (!intel().npu) intel().runtimeInstalled = false
            // Native puts the regular copy back where the version was chosen.
            if (state.speech.postCallConfig.model === GPU_VERSION_ID) {
                state.speech.postCallConfig = {provider: 'whisper', model: GPU_VERSION_OF}
                send(POST_CALL_TRANSCRIPT_CONFIG_CHANGED_EVENT, null)
            }
            changed()
            return null
        },
    }
}
