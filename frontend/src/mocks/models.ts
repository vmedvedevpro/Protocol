import {emit} from '@tauri-apps/api/event'
import type {NativeEvent} from '@/api/events'
import {
    BUILTIN_AI_DOWNLOAD_PROGRESS_EVENT,
    type BuiltInModelInfo,
    type BuiltInModelStatus,
    PARAKEET_DOWNLOAD_COMPLETE_EVENT,
    PARAKEET_DOWNLOAD_ERROR_EVENT,
    PARAKEET_DOWNLOAD_PROGRESS_EVENT,
    PARAKEET_MODEL,
    type ParakeetModelInfo,
    POST_CALL_WHISPER_MODEL,
    type SpeechModelStatus,
    WHISPER_DOWNLOAD_ACTIVATING_EVENT,
    WHISPER_DOWNLOAD_COMPLETE_EVENT,
    WHISPER_DOWNLOAD_ERROR_EVENT,
    WHISPER_DOWNLOAD_PROGRESS_EVENT,
    type WhisperModelInfo,
} from '@/api/models'
import type {MockHandler} from './handlers'

/**
 * Speech and summary models, ported from the old browser preview
 * (`162e8be:frontend/src/dev/preview/models.ts`): the catalog's entries with
 * the sizes Hugging Face lists, which of them are installed, and downloads
 * that report progress by the native events, then complete or fail.
 *
 * `createMockModels()` is a machine that finished first launch: Parakeet,
 * Whisper Large V3 Turbo (compressed) and the recommended summary model are
 * installed. `createMockModels({fresh: true})` is a new install with none,
 * for first launch; `?models=fresh` gives it in pnpm dev.
 */

const MODELS_DIR = 'C:/Users/preview/AppData/Local/vmedvedevpro/Protocol/data/models'

type WhisperEntry = Omit<WhisperModelInfo, 'path' | 'status' | 'languages'>

// model-catalog/catalog.json, in its order.
const WHISPER: WhisperEntry[] = [
    {name: 'small', display_name: 'Small', description: 'Better accuracy, moderate speed', accuracy: 'Good', speed: 'Medium', tier: 'basic', size_bytes: 487_601_967, recommended: false},
    {name: 'medium-q5_0', display_name: 'Medium Compressed', description: 'Professional quality at a third of the size', accuracy: 'High', speed: 'Medium', tier: 'basic', size_bytes: 539_212_467, recommended: false},
    {name: 'large-v3-q5_0', display_name: 'Large V3 Compressed', description: 'Large V3 at a third of the size, high accuracy', accuracy: 'High', speed: 'Slow', tier: 'basic', size_bytes: 1_081_140_203, recommended: false},
    {name: 'large-v3-turbo', display_name: 'Large V3 Turbo', description: 'Best accuracy with improved speed', accuracy: 'High', speed: 'Medium', tier: 'basic', size_bytes: 1_624_555_275, recommended: false},
    {name: 'large-v3', display_name: 'Large V3', description: 'Most accurate, latest large model', accuracy: 'High', speed: 'Slow', tier: 'basic', size_bytes: 3_095_033_483, recommended: false},
    {name: 'tiny', display_name: 'Tiny', description: 'Fastest processing, good for real-time use', accuracy: 'Decent', speed: 'Very Fast', tier: null, size_bytes: 77_691_713, recommended: false},
    {name: 'base', display_name: 'Base', description: 'Good balance of speed and accuracy', accuracy: 'Good', speed: 'Fast', tier: null, size_bytes: 147_951_465, recommended: false},
    {name: 'medium', display_name: 'Medium', description: 'High accuracy for professional use', accuracy: 'High', speed: 'Slow', tier: null, size_bytes: 1_533_763_059, recommended: false},
    {name: 'tiny-q5_1', display_name: 'Tiny Compressed', description: 'Tiny at under half the size, faster processing', accuracy: 'Decent', speed: 'Very Fast', tier: null, size_bytes: 32_152_673, recommended: false},
    {name: 'base-q5_1', display_name: 'Base Compressed', description: 'Base at under half the size, good balance of speed and accuracy', accuracy: 'Good', speed: 'Fast', tier: null, size_bytes: 59_707_625, recommended: false},
    {name: 'small-q5_1', display_name: 'Small Compressed', description: 'Small at under half the size, faster', accuracy: 'Good', speed: 'Fast', tier: null, size_bytes: 190_085_487, recommended: false},
    {name: POST_CALL_WHISPER_MODEL, display_name: 'Large V3 Turbo Compressed', description: 'Large V3 Turbo at a third of the size, best balance', accuracy: 'High', speed: 'Medium', tier: 'basic', size_bytes: 574_041_195, recommended: true},
]

const PARAKEET: Omit<ParakeetModelInfo, 'status'> = {
    name: PARAKEET_MODEL,
    path: `${MODELS_DIR}/parakeet-tdt-0.6b-v3-int8`,
    size_bytes: 670_619_706,
    quantization: 'Int8',
    speed: 'Ultra Fast (v3)',
    description: 'Real time • Best for speed, great accuracy',
    display_name: 'Lightning',
    recommended: true,
    languages: ['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk'],
}

type BuiltInEntry = Omit<BuiltInModelInfo, 'status' | 'path'>

// The catalog's llama entries; native recommends the best ranked one that fits the memory.
const BUILT_IN: BuiltInEntry[] = [
    {name: 'qwen3.5:4b', display_name: 'Qwen 3.5 4B (High Quality)', description: 'High-quality Qwen 3.5 model for built-in summaries. Best local Qwen option in the current lineup.', size_bytes: 2_740_937_888, context_size: 32_768, gguf_file: 'Qwen3.5-4B-Q4_K_M.gguf', recommended: true},
    {name: 'qwen3.5:2b', display_name: 'Qwen 3.5 2B (Balanced)', description: 'Balanced Qwen 3.5 model for built-in summaries. Higher quality with modest local requirements.', size_bytes: 1_280_835_840, context_size: 32_768, gguf_file: 'Qwen3.5-2B-Q4_K_M.gguf', recommended: true},
    {name: 'gemma3:4b', display_name: 'Gemma 3 4B (Balanced)', description: 'Balanced model. Great quality/speed trade-off. Requires ~3.5GB RAM.', size_bytes: 2_489_757_856, context_size: 32_768, gguf_file: 'gemma-3-4b-it-Q4_K_M.gguf', recommended: false},
    {name: 'gemma3:1b', display_name: 'Gemma 3 1B (Fast)', description: 'Fastest model. Runs on any hardware with ~1GB RAM. Good for quick summaries.', size_bytes: 806_058_272, context_size: 32_768, gguf_file: 'gemma-3-1b-it-Q4_K_M.gguf', recommended: false},
]

const RECOMMENDED_SUMMARY_MODEL = 'qwen3.5:4b'

/** Native reports a download a few times a second; the fake one steps every TICK_MS. */
const TICK_MS = 250

export function createMockModels({fresh = false}: { fresh?: boolean } = {}) {
    stopMockDownloads()
    const installed = !fresh
    return {
        parakeet: (installed ? 'Available' : 'Missing') as SpeechModelStatus,
        whisper: Object.fromEntries(WHISPER.map(({name}) => [
            name,
            (installed && name === POST_CALL_WHISPER_MODEL ? 'Available' : 'Missing') as SpeechModelStatus,
        ])),
        builtIn: Object.fromEntries(BUILT_IN.map(({name}) => [
            name,
            (installed && name === RECOMMENDED_SUMMARY_MODEL ? {type: 'available'} : {type: 'not_downloaded'}) as BuiltInModelStatus,
        ])),
        recommendedSummary: RECOMMENDED_SUMMARY_MODEL,
        /** The after-meeting model a completed `enablePostCall` download saved, as native does in the database. */
        postCallModel: (installed ? POST_CALL_WHISPER_MODEL : null) as string | null,
        /** Percent a fake download gains each tick; a test raises it to finish in a tick or two. */
        downloadStep: 4,
        /** Downloads (`downloadKey`, such as `parakeet:parakeet-tdt-0.6b-v3-int8`) that fail halfway; a retry succeeds. */
        failing: [] as string[],
    }
}

export type MockModels = ReturnType<typeof createMockModels>

// Fake downloads still running. A new mock state (each test, each story)
// stops those of the previous one, which would otherwise write into it.
const running = new Set<ReturnType<typeof setInterval>>()

function stopMockDownloads() {
    for (const timer of running) clearInterval(timer)
    running.clear()
}

function send<T>(event: NativeEvent<T>, payload: T) {
    // After clearMocks() at the end of a test there is no IPC to send to.
    emit(event, payload).catch(() => undefined)
}

/**
 * Steps `progress` from 0 to 100, calling `onTick` with each value below
 * 100; resolves at 100, or rejects halfway when `fails`.
 */
function fakeDownload(models: MockModels, fails: boolean, onTick: (progress: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        let progress = 0
        const timer = setInterval(() => {
            progress = Math.min(100, progress + models.downloadStep)
            if (fails && progress >= 50) {
                clearInterval(timer)
                running.delete(timer)
                reject(new Error('Network error: connection reset while downloading'))
                return
            }
            if (progress < 100) {
                onTick(progress)
                return
            }
            clearInterval(timer)
            running.delete(timer)
            resolve()
        }, TICK_MS)
        running.add(timer)
    })
}

/** Takes a key off the failing list: a retry of a failed download succeeds. */
function takeFailure(models: MockModels, key: string): boolean {
    const index = models.failing.indexOf(key)
    if (index < 0) return false
    models.failing.splice(index, 1)
    return true
}

const isDownloading = (status: SpeechModelStatus | BuiltInModelStatus | undefined) =>
    typeof status === 'object' && ('Downloading' in status || ('type' in status && status.type === 'downloading'))

/**
 * The model commands; they read and change `state.models` the way native
 * code changes the disk, looking it up on each call, since a reset puts a
 * new one there.
 */
export function modelsHandlers(state: {models: MockModels}): Record<string, MockHandler> {
    const parakeetDownload = async (modelName: string) => {
        const models = state.models
        if (modelName !== PARAKEET_MODEL) throw `Model not found: ${modelName}`
        const fails = takeFailure(models, `parakeet:${modelName}`)
        models.parakeet = {Downloading: {progress: 0}}
        try {
            await fakeDownload(models, fails, (progress) => {
                models.parakeet = {Downloading: {progress}}
                send(PARAKEET_DOWNLOAD_PROGRESS_EVENT, {
                    modelName,
                    progress,
                    downloaded_mb: (PARAKEET.size_bytes! / 1_048_576) * progress / 100,
                    total_mb: PARAKEET.size_bytes! / 1_048_576,
                    speed_mbps: 12.4,
                    status: 'downloading',
                })
            })
        } catch (error) {
            models.parakeet = 'Missing'
            const message = (error as Error).message
            send(PARAKEET_DOWNLOAD_ERROR_EVENT, {modelName, error: message})
            throw `Failed to download Parakeet model: ${message}`
        }
        models.parakeet = 'Available'
        send(PARAKEET_DOWNLOAD_COMPLETE_EVENT, {modelName})
        return null
    }

    const whisperDownload = async (modelName: string, enablePostCall: boolean) => {
        const models = state.models
        if (enablePostCall && modelName !== POST_CALL_WHISPER_MODEL) {
            throw 'Native optional activation is only supported for the recommended Whisper model'
        }
        // An activation does not download an installed, valid copy again.
        if (!(enablePostCall && models.whisper[modelName] === 'Available')) {
            const fails = takeFailure(models, `whisper:${modelName}`)
            models.whisper[modelName] = {Downloading: {progress: 0}}
            try {
                await fakeDownload(models, fails, (progress) => {
                    models.whisper[modelName] = {Downloading: {progress}}
                    send(WHISPER_DOWNLOAD_PROGRESS_EVENT, {modelName, progress})
                })
            } catch (error) {
                models.whisper[modelName] = 'Missing'
                const message = (error as Error).message
                send(WHISPER_DOWNLOAD_ERROR_EVENT, {modelName, error: message, postCallManaged: enablePostCall})
                throw `Failed to download model: ${message}`
            }
            models.whisper[modelName] = 'Available'
        }
        if (enablePostCall) {
            send(WHISPER_DOWNLOAD_ACTIVATING_EVENT, {modelName})
            models.postCallModel = modelName
        }
        send(WHISPER_DOWNLOAD_COMPLETE_EVENT, {modelName, postCallManaged: enablePostCall})
        return null
    }

    const builtInInfo = (entry: BuiltInEntry): BuiltInModelInfo => ({
        ...entry,
        path: `${MODELS_DIR}/summary/${entry.gguf_file}`,
        status: state.models.builtIn[entry.name] ?? {type: 'not_downloaded'},
    })

    return {
        // src-tauri/src/parakeet_engine/commands.rs
        parakeet_init: () => null,
        parakeet_get_available_models: (): ParakeetModelInfo[] => [{...PARAKEET, status: state.models.parakeet}],
        parakeet_has_available_models: () => state.models.parakeet === 'Available',
        parakeet_download_model: ({modelName}) => parakeetDownload(String(modelName)),
        parakeet_retry_download: ({modelName}) => {
            if (isDownloading(state.models.parakeet)) throw `Download already in progress for model: ${String(modelName)}`
            return parakeetDownload(String(modelName))
        },

        // src-tauri/src/whisper_engine/commands.rs
        whisper_init: () => null,
        whisper_get_available_models: (): WhisperModelInfo[] => WHISPER.map((entry) => ({
            ...entry,
            path: `${MODELS_DIR}/ggml-${entry.name}.bin`,
            status: state.models.whisper[entry.name] ?? 'Missing',
            languages: ['*'],
        })),
        whisper_has_available_models: () => Object.values(state.models.whisper).includes('Available'),
        whisper_download_model: ({modelName, enablePostCall}) => whisperDownload(String(modelName), enablePostCall === true),

        // src-tauri/src/summary/summary_engine/commands.rs
        builtin_ai_list_models: () => BUILT_IN.map(builtInInfo),
        builtin_ai_get_model_info: ({modelName}) => {
            const entry = BUILT_IN.find(({name}) => name === modelName)
            return entry ? builtInInfo(entry) : null
        },
        builtin_ai_is_model_ready: ({modelName}) => state.models.builtIn[String(modelName)]?.type === 'available',
        builtin_ai_get_recommended_model: () => state.models.recommendedSummary,
        builtin_ai_download_model: async ({modelName}) => {
            const models = state.models
            const model = String(modelName)
            const entry = BUILT_IN.find(({name}) => name === model)
            if (!entry) throw `Unknown model: ${model}`
            if (isDownloading(models.builtIn[model])) throw `Download already in progress for ${model}`
            const fails = takeFailure(models, `builtIn:${model}`)
            const totalMb = entry.size_bytes! / 1_048_576
            models.builtIn[model] = {type: 'downloading', progress: 0}
            try {
                await fakeDownload(models, fails, (progress) => {
                    models.builtIn[model] = {type: 'downloading', progress}
                    send(BUILTIN_AI_DOWNLOAD_PROGRESS_EVENT, {
                        model,
                        progress,
                        downloaded_mb: totalMb * progress / 100,
                        total_mb: totalMb,
                        speed_mbps: 18.2,
                        status: 'downloading',
                    })
                })
            } catch (error) {
                const message = (error as Error).message
                models.builtIn[model] = {type: 'not_downloaded'}
                send(BUILTIN_AI_DOWNLOAD_PROGRESS_EVENT, {model, progress: 0, downloaded_mb: 0, total_mb: 0, speed_mbps: 0, status: 'error', error: message})
                throw message
            }
            models.builtIn[model] = {type: 'available'}
            send(BUILTIN_AI_DOWNLOAD_PROGRESS_EVENT, {model, progress: 100, downloaded_mb: 0, total_mb: 0, speed_mbps: 0, status: 'completed'})
            return null
        },
    }
}
