import type {LocalStackStatus} from '@/api/localStack'
import type {MockHandler} from './handlers'
import type {MockLive} from './live'

/**
 * `get_local_stack_status` and the unloads (whisper_engine/commands.rs),
 * from what the live mock has loaded: a start loads the live model, an
 * unload drops both.
 */
export function localStackHandlers(state: {live: MockLive}): Record<string, MockHandler> {
    const refuseWhileRecording = () => {
        if (state.live.recording) throw 'Cannot unload models while recording'
    }
    return {
        get_local_stack_status: (): LocalStackStatus => ({
            recording: !!state.live.recording,
            whisper: {loaded: state.live.loaded.whisper, model: state.live.loaded.whisper ? 'large-v3-turbo-q5_0' : null, openvino: null, gpuStopped: state.live.gpuStopped},
            parakeet: {loaded: state.live.loaded.parakeet, model: state.live.loaded.parakeet ? 'parakeet-tdt-0.6b-v3-int8' : null, backend: 'CPU'},
            sttIdleUnloadSecs: 120,
            llmIdleUnloadSecs: 300,
            sttLastUnloadSecs: null,
            llmLastUnloadSecs: null,
            modelsDirBytes: 2_684_354_560,
            dataDirBytes: 3_221_225_472,
            modelsDir: '/home/user/.local/share/protocol/models',
            vramHintMb: 0,
            cuda: false,
            vulkan: true,
            sttBackend: 'vulkan',
            networkPolicy: 'local-first',
            networkNote: 'No telemetry. Cloud LLM only if you add an API key and select that provider.',
        }),
        whisper_gpu_retry: () => {
            state.live.gpuStopped = null
            return null
        },
        force_unload_stt_models: () => {
            refuseWhileRecording()
            state.live.loaded = {parakeet: false, whisper: false}
            return null
        },
        force_unload_all_models: () => {
            refuseWhileRecording()
            state.live.loaded = {parakeet: false, whisper: false}
            return null
        },
    }
}
