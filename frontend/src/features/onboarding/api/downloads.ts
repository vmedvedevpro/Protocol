import {downloadGpuVersion, downloadIntelLibraries, INTEL_LIBRARIES_ID} from '@/api/intel'
import {
    downloadBuiltInModel,
    downloadParakeetModel,
    downloadWhisperModel,
    type ModelEngine,
    PARAKEET_MODEL,
    POST_CALL_WHISPER_MODEL,
    retryParakeetDownload,
} from '@/api/models'

/**
 * One download of first launch, as its row shows it. The list is data, so
 * #117 can put Whisper's Intel GPU version in place of the processor copy
 * and add Intel's NPU libraries where the computer has them without
 * touching the step: a row reads its state from its engine's list and
 * `downloadsQuery` (`downloadKey(engine, model)`), and runs `start`.
 */
export interface FirstLaunchDownload {
    id: string
    /** What the model is for: "Live text". */
    title: string
    /** The model, and where it runs. */
    detail: string
    engine: ModelEngine
    model: string
    /**
     * Starts the download and resolves when native code has verified the
     * model and, where it has to, made it the one in use. Rejects on failure,
     * and at once while the same download runs (`isAlreadyDownloading`).
     */
    start: () => Promise<unknown>
    /** Starts it again after a failure. */
    retry: () => Promise<unknown>
}

/** The built-in summary model `builtin_ai_get_recommended_model` picked, with the name the catalog shows. */
export interface SummaryModel {
    name: string
    displayName: string
}

/**
 * The hardware path (#117, as the old setup step chose it): Whisper's Intel
 * GPU version in place of the processor copy on an Intel GPU, and Intel's
 * libraries for Parakeet on an Intel NPU that waits for them. `track` runs
 * an Intel download and keeps its record (`trackIntelDownload`), since
 * native sends no event when one fails.
 */
export interface Hardware {
    /** The Intel GPU version's id when this computer can run it. */
    gpuVersion: string | null
    /** An Intel NPU is present: Parakeet runs on it once Intel's libraries are here (the Intel GPU version brings them too). */
    npuLibraries: boolean
    track: (engine: 'intelGpu' | 'intelLibraries', id: string, run: () => Promise<unknown>) => Promise<unknown>
}

const NO_INTEL: Hardware = {gpuVersion: null, npuLibraries: false, track: (_engine, _id, run) => run()}

/**
 * What first launch downloads, in order: Parakeet first, since recording
 * needs a live model; Intel's libraries for the NPU next, which keep only
 * while Parakeet v3 is there; then Whisper Large V3 Turbo, or on an Intel
 * GPU its Intel GPU version, which native code makes the after-meeting model
 * once its download is verified (`enablePostCall`, `choose`); then the
 * summary model. A model is in use only after its download completed: native
 * code activates Whisper, and `complete_onboarding` selects Parakeet and the
 * summary model, which a meeting reads only when it runs.
 */
export function firstLaunchDownloads(summary: SummaryModel, hardware: Hardware = NO_INTEL): FirstLaunchDownload[] {
    const {gpuVersion, track} = hardware
    const whisper = () => downloadWhisperModel(POST_CALL_WHISPER_MODEL, {enablePostCall: true})
    const gpu = () => track('intelGpu', gpuVersion ?? '', () => downloadGpuVersion(gpuVersion ?? '', {choose: true}))
    const libraries = () => track('intelLibraries', INTEL_LIBRARIES_ID, downloadIntelLibraries)
    const builtIn = () => downloadBuiltInModel(summary.name)
    const npu: FirstLaunchDownload[] = hardware.npuLibraries && !gpuVersion ? [{
        id: 'npu',
        title: 'Live text on the Intel NPU',
        detail: "Intel's libraries for Parakeet",
        engine: 'intelLibraries',
        model: INTEL_LIBRARIES_ID,
        start: libraries,
        retry: libraries,
    }] : []
    return [
        {
            id: 'live',
            title: 'Live text',
            detail: hardware.npuLibraries && !gpuVersion ? 'Parakeet · on the Intel NPU' : 'Parakeet · on the processor',
            engine: 'parakeet',
            model: PARAKEET_MODEL,
            start: () => downloadParakeetModel(PARAKEET_MODEL),
            retry: () => retryParakeetDownload(PARAKEET_MODEL),
        },
        ...npu,
        gpuVersion ? {
            id: 'afterMeetings',
            title: 'Transcript after meetings',
            detail: 'Whisper Large V3 Turbo · on the Intel GPU',
            engine: 'intelGpu',
            model: gpuVersion,
            start: gpu,
            retry: gpu,
        } : {
            id: 'afterMeetings',
            title: 'Transcript after meetings',
            detail: 'Whisper Large V3 Turbo',
            engine: 'whisper',
            model: POST_CALL_WHISPER_MODEL,
            start: whisper,
            retry: whisper,
        },
        {
            id: 'summaries',
            title: 'Summaries',
            detail: summary.displayName,
            engine: 'builtIn',
            model: summary.name,
            start: builtIn,
            retry: builtIn,
        },
    ]
}
