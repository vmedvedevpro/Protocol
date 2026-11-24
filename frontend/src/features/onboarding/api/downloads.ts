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
 * What first launch downloads, in order: Parakeet first, since recording
 * needs a live model; then Whisper Large V3 Turbo, which native code makes
 * the after-meeting model once its download is verified; then the summary
 * model. A model is in use only after its download completed: native code
 * activates Whisper, and `complete_onboarding` selects Parakeet and the
 * summary model, which a meeting reads only when it runs.
 */
export function firstLaunchDownloads(summary: SummaryModel): FirstLaunchDownload[] {
    const whisper = () => downloadWhisperModel(POST_CALL_WHISPER_MODEL, {enablePostCall: true})
    const builtIn = () => downloadBuiltInModel(summary.name)
    return [
        {
            id: 'live',
            title: 'Live text',
            detail: 'Parakeet · on the processor',
            engine: 'parakeet',
            model: PARAKEET_MODEL,
            start: () => downloadParakeetModel(PARAKEET_MODEL),
            retry: () => retryParakeetDownload(PARAKEET_MODEL),
        },
        {
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
