/**
 * Speech models (Parakeet for live text, Whisper after meetings) and the
 * built-in summary models: whether they are installed, their downloads and
 * the events those report. Native code owns every download; the types mirror
 * `ModelInfo` and `ModelStatus` in parakeet_engine/parakeet_engine.rs,
 * whisper_engine/whisper_engine.rs and summary/summary_engine/model_manager.rs,
 * and the event payloads the download commands emit.
 *
 * The lists come from Query. A download's live progress comes only by event,
 * so `useModelDownloadSync` (`modelDownloadSync.ts`, mounted once by the
 * shell) keeps `downloadsQuery` from the events and refreshes a list when
 * its download ends; `modelState` folds the two into what a screen shows.
 * Settings › Speech models (#117) cancels and removes them; the models chosen
 * for each task are in `speech.ts`. The Intel GPU version and Intel's
 * libraries are in `intel.ts`, the speaker engine in `diarization.ts`.
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from './core'
import type {NativeEvent} from './events'

/** The live model native code defaults to (`config::DEFAULT_PARAKEET_MODEL`). */
export const PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3-int8'

/**
 * Whisper Large V3 Turbo, compressed: the after-meeting model the app offers
 * (`optional_models::WHISPER_MODEL`), the only one native code activates
 * after its download (`downloadWhisperModel` with `enablePostCall`).
 */
export const POST_CALL_WHISPER_MODEL = 'large-v3-turbo-q5_0'

// --- Speech models ---------------------------------------------------------

/**
 * A speech model on disk. Serde's external tagging: a unit variant is its
 * name, the others an object keyed by it.
 */
export type SpeechModelStatus =
    | 'Available'
    | 'Missing'
    | {Downloading: {progress: number}}
    | {Error: string}
    | {Corrupted: {file_size: number, expected_min_size: number}}

export interface ParakeetModelInfo {
    name: string
    path: string
    /** Bytes installed, else on Hugging Face; null while unknown. */
    size_bytes: number | null
    quantization: 'FP32' | 'Int8'
    speed: string
    status: SpeechModelStatus
    description: string
    /** From the model catalog ("Lightning"). */
    display_name: string
    recommended: boolean
    languages: string[]
}

export interface WhisperModelInfo {
    name: string
    path: string
    size_bytes: number | null
    accuracy: string
    speed: string
    status: SpeechModelStatus
    description: string
    display_name: string
    tier: string | null
    recommended: boolean
    /** `['*']` for every language. */
    languages: string[]
    /** The Intel GPU version (Windows): the ggml models it serves; absent for the others. */
    companion_of?: string[]
}

/** The engine is created at startup off the main thread; init makes sure it exists before a read. */
export async function getParakeetModels() {
    await command<null>('parakeet_init')
    return command<ParakeetModelInfo[]>('parakeet_get_available_models')
}

export async function getWhisperModels() {
    await command<null>('whisper_init')
    return command<WhisperModelInfo[]>('whisper_get_available_models')
}

/**
 * Downloads a Parakeet model and resolves when the download has ended:
 * completed, or cancelled (native resolves then too, so check the list).
 * Progress, completion and failure come as events.
 */
export async function downloadParakeetModel(modelName: string) {
    await command<null>('parakeet_init')
    return command<null>('parakeet_download_model', {modelName})
}

/** Downloads again after a failure; rejects while the same download still runs. */
export async function retryParakeetDownload(modelName: string) {
    await command<null>('parakeet_init')
    return command<null>('parakeet_retry_download', {modelName})
}

/**
 * Downloads a Whisper model and resolves when it has ended. With
 * `enablePostCall` (only `POST_CALL_WHISPER_MODEL`) native code checks an
 * installed copy instead of downloading it again, and saves the model as the
 * after-meeting model once the file is verified, before it resolves: the
 * activation survives a reload of the window, which a promise here would not.
 * It needs the database (first launch creates it first).
 */
export async function downloadWhisperModel(modelName: string, {enablePostCall = false} = {}) {
    await command<null>('whisper_init')
    return command<null>('whisper_download_model', {modelName, enablePostCall})
}

/** Cancels a Parakeet download; resolves once native let go of its partial files, so a retry is safe. */
export const cancelParakeetDownload = (modelName: string) => command<boolean>('parakeet_cancel_download', {modelName})

/** Cancels a Whisper download; native then sends its error event with "cancelled by user". */
export const cancelWhisperDownload = (modelName: string) => command<null>('whisper_cancel_download', {modelName})

/**
 * Removes a Parakeet model's files, whole or broken (the old UI's Remove
 * used the same command). The live model, if it was this one, is not
 * changed: a start then reports it missing.
 */
export const removeParakeetModel = (modelName: string) => command<string>('parakeet_delete_corrupted_model', {modelName})

/**
 * Removes a Whisper model's files, whole or broken. `POST_CALL_WHISPER_MODEL`
 * goes through `uninstallOptionalModel('whisper')` instead, which also puts
 * back the models that used it.
 */
export const removeWhisperModel = (modelName: string) => command<string>('whisper_delete_corrupted_model', {modelName})

/** The models native code activates after their download and removes with their choices (optional_models.rs). */
export type OptionalModel = 'whisper' | 'nemotron'

/**
 * Removes Whisper Large V3 Turbo or Nemotron natively: their choices go back
 * first (the live and after-meeting models, the speaker engine), then the
 * files. Refused while a recording or a post-call pass runs.
 */
export const uninstallOptionalModel = (model: OptionalModel) => command<null>('uninstall_optional_model', {model})

/** Parakeet v2 is no longer offered, even while it is on disk. */
export const isOfferedParakeet = (name: string) => name !== 'parakeet-tdt-0.6b-v2-int8'

/** The Intel GPU version of a Whisper model lists the models it serves (`companion_of`). */
export const isGpuVersion = (model: {companion_of?: string[]} | undefined | null) => !!model?.companion_of?.length

const ENGINE_NAMES = {parakeet: 'Parakeet', whisper: 'Whisper'} as const

/**
 * "Whisper Large V3 Turbo": the engine, then the catalog's name without an
 * engine name it may repeat, or the id when it has none. The Intel GPU
 * version reads apart from the model it serves.
 */
export function speechModelLabel(engine: 'parakeet' | 'whisper', model: {name: string, display_name?: string | null, companion_of?: string[]}): string {
    const own = (model.display_name ?? '').trim().replace(new RegExp(`^${ENGINE_NAMES[engine]}\\s+`, 'i'), '') || model.name
    return `${ENGINE_NAMES[engine]} ${own}${isGpuVersion(model) ? ' · Intel GPU' : ''}`
}

// --- Built-in summary models -----------------------------------------------

/** Serde's internal tagging (`type`), snake_case. Sizes in bytes; 0 when none is on record. */
export type BuiltInModelStatus =
    | {type: 'not_downloaded'}
    | {type: 'downloading', progress: number}
    | {type: 'available'}
    | {type: 'incomplete', file_size: number, expected_size: number}
    | {type: 'corrupted', file_size: number, expected_min_size: number}
    | {type: 'error', message: string}

export interface BuiltInModelInfo {
    /** The catalog id, `qwen3.5:4b`. */
    name: string
    /** "Qwen 3.5 4B (High Quality)". */
    display_name: string
    status: BuiltInModelStatus
    path: string
    size_bytes: number | null
    context_size: number
    description: string
    gguf_file: string
    recommended: boolean
}

export const listBuiltInModels = () => command<BuiltInModelInfo[]>('builtin_ai_list_models')

/** Whether the file is there and whole; `refresh` scans the disk first instead of trusting the last scan. */
export const isBuiltInModelReady = (modelName: string, {refresh = false} = {}) =>
    command<boolean>('builtin_ai_is_model_ready', {modelName, refresh})

/**
 * The summary model this computer should run: the catalog's best
 * recommended model that fits its memory. A fresh database already uses it.
 */
export const getRecommendedSummaryModel = () => command<string>('builtin_ai_get_recommended_model')

/**
 * Downloads a built-in model and resolves when the file is verified; rejects
 * on failure, with "CANCELLED: …" after a cancel, and with "Download already
 * in progress" while it runs. Progress comes as `builtin-ai-download-progress`.
 */
export const downloadBuiltInModel = (modelName: string) => command<null>('builtin_ai_download_model', {modelName})

/**
 * A second call for a download that runs: every engine rejects it with this
 * and also sends it as its error event, while the first download goes on.
 * Nothing failed.
 */
export const isAlreadyDownloading = (error: unknown) => /already in progress/i.test(String(error instanceof Error ? error.message : error))

// --- Events ----------------------------------------------------------------

/** Parakeet's progress; `status: 'cancelled'` once a cancel has stopped it. */
export interface ParakeetDownloadProgress {
    modelName: string
    /** 0 to 100; stays below 100 until the files are verified. */
    progress: number
    downloaded_bytes?: number
    total_bytes?: number
    downloaded_mb?: number
    total_mb?: number
    speed_mbps?: number
    status: 'downloading' | 'cancelled'
}

export const PARAKEET_DOWNLOAD_PROGRESS_EVENT = 'parakeet-model-download-progress' as NativeEvent<ParakeetDownloadProgress>
export const PARAKEET_DOWNLOAD_COMPLETE_EVENT = 'parakeet-model-download-complete' as NativeEvent<{modelName: string}>
export const PARAKEET_DOWNLOAD_ERROR_EVENT = 'parakeet-model-download-error' as NativeEvent<{modelName: string, error: string}>

/** Whisper reports a percent only, below 100 until the file is verified. */
export const WHISPER_DOWNLOAD_PROGRESS_EVENT = 'model-download-progress' as NativeEvent<{modelName: string, progress: number}>
/** A `enablePostCall` download is verified and being saved as the after-meeting model. */
export const WHISPER_DOWNLOAD_ACTIVATING_EVENT = 'model-download-activating' as NativeEvent<{modelName: string}>
export const WHISPER_DOWNLOAD_COMPLETE_EVENT = 'model-download-complete' as NativeEvent<{modelName: string, postCallManaged: boolean}>
/** Also a cancel, as "Download cancelled by user". */
export const WHISPER_DOWNLOAD_ERROR_EVENT = 'model-download-error' as NativeEvent<{modelName: string, error: string, postCallManaged: boolean}>

/** `uninstall_optional_model` removed one (also the Intel GPU version's removal, as `whisper`). */
export const OPTIONAL_MODEL_REMOVED_EVENT = 'optional-model-removed' as NativeEvent<OptionalModel>

/**
 * Every step of a built-in download comes in this one event: `completed`
 * only after the file is verified, `error` with its message, `cancelled`
 * after a cancel (no sizes then).
 */
export interface BuiltInDownloadProgress {
    model: string
    progress: number
    downloaded_mb?: number
    total_mb?: number
    speed_mbps?: number
    status: 'downloading' | 'completed' | 'error' | 'cancelled'
    error?: string
}

export const BUILTIN_AI_DOWNLOAD_PROGRESS_EVENT = 'builtin-ai-download-progress' as NativeEvent<BuiltInDownloadProgress>

// --- Queries ---------------------------------------------------------------

/**
 * What downloads: the two speech engines, the built-in summary models,
 * Nemotron (`diarization.ts`), and on Windows the Intel GPU version and
 * Intel's libraries alone (`intel.ts`).
 */
export type ModelEngine = 'parakeet' | 'whisper' | 'builtIn' | 'nemotron' | 'intelGpu' | 'intelLibraries'

/** A download as the events last told it. A download with no entry runs nowhere, or ran before the listener. */
export type DownloadState =
    | {state: 'downloading', progress: number, downloadedMb?: number, totalMb?: number, speedMbps?: number}
    /** Whisper only: verified, being saved as the after-meeting model. */
    | {state: 'activating'}
    | {state: 'failed', error: string}

/** Downloads by `downloadKey`. */
export type Downloads = Record<string, DownloadState>

export const downloadKey = (engine: ModelEngine, model: string) => `${engine}:${model}`

export const modelKeys = {
    all: ['models'] as const,
    parakeet: () => [...modelKeys.all, 'parakeet'] as const,
    whisper: () => [...modelKeys.all, 'whisper'] as const,
    builtIn: () => [...modelKeys.all, 'builtIn'] as const,
    builtInReady: (model: string) => [...modelKeys.all, 'builtIn', 'ready', model] as const,
    recommendedSummary: () => [...modelKeys.all, 'recommendedSummary'] as const,
    downloads: () => [...modelKeys.all, 'downloads'] as const,
}

export const parakeetModelsQuery = queryOptions({queryKey: modelKeys.parakeet(), queryFn: getParakeetModels})

export const whisperModelsQuery = queryOptions({queryKey: modelKeys.whisper(), queryFn: getWhisperModels})

export const builtInModelsQuery = queryOptions({queryKey: modelKeys.builtIn(), queryFn: listBuiltInModels})

/** Scans the disk (`refresh`), so a file removed by hand reads as missing. */
export const builtInModelReadyQuery = (model: string) => queryOptions({
    queryKey: modelKeys.builtInReady(model),
    queryFn: () => isBuiltInModelReady(model, {refresh: true}),
})

/** The computer's memory does not change while the app runs. */
export const recommendedSummaryModelQuery = queryOptions({
    queryKey: modelKeys.recommendedSummary(),
    queryFn: getRecommendedSummaryModel,
    staleTime: Infinity,
})

/**
 * The downloads the events have reported, written only by
 * `useModelDownloadSync`. There is nothing to read: it starts empty, and it
 * is never fetched (`enabled: false`), so invalidating `modelKeys.all`
 * refreshes the lists without wiping it.
 */
export const downloadsQuery = queryOptions({
    queryKey: modelKeys.downloads(),
    queryFn: (): Downloads => ({}),
    initialData: {} as Downloads,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
})

// --- What a screen shows -----------------------------------------------------

/**
 * One model as a screen shows it: `ready` once installed and verified,
 * `downloading` with a percent that stays below 100 until then,
 * `activating` (Whisper, being enabled), `failed` with the message of the
 * last failure, or `missing` (not downloaded, or a broken copy to download
 * again).
 */
export type ModelState =
    | {kind: 'ready'}
    | {kind: 'downloading', progress: number}
    | {kind: 'activating'}
    | {kind: 'failed', error: string}
    | {kind: 'missing'}

function installedState(status: SpeechModelStatus | BuiltInModelStatus | undefined): ModelState {
    if (status === undefined || status === 'Missing') return {kind: 'missing'}
    if (status === 'Available') return {kind: 'ready'}
    if ('type' in status) {
        if (status.type === 'available') return {kind: 'ready'}
        if (status.type === 'downloading') return {kind: 'downloading', progress: status.progress}
        if (status.type === 'error') return {kind: 'failed', error: status.message}
        return {kind: 'missing'}
    }
    if ('Downloading' in status) return {kind: 'downloading', progress: status.Downloading.progress}
    if ('Error' in status) return {kind: 'failed', error: status.Error}
    return {kind: 'missing'}
}

/**
 * Folds a model's status from its list with what the events said since. An
 * installed copy is ready whatever a later download did, except while
 * Whisper is being enabled; otherwise a download running or failed now wins
 * over the list, which reads the disk and catches up when the download ends.
 * Progress stays below 100: only the completion, after verification, makes
 * a model ready.
 */
export function modelState(status: SpeechModelStatus | BuiltInModelStatus | undefined, download?: DownloadState): ModelState {
    const installed = installedState(status)
    if (download?.state === 'activating') return {kind: 'activating'}
    if (installed.kind === 'ready') return installed
    if (download?.state === 'failed') return {kind: 'failed', error: download.error}
    if (download?.state === 'downloading') return {kind: 'downloading', progress: Math.min(download.progress, 99)}
    if (installed.kind === 'downloading') return {kind: 'downloading', progress: Math.min(installed.progress, 99)}
    return installed
}
