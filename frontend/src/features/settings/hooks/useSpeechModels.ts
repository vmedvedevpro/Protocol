import {useQuery, useQueryClient} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {
    cancelParakeetDownload,
    cancelWhisperDownload,
    downloadKey,
    downloadParakeetModel,
    downloadsQuery,
    downloadWhisperModel,
    isAlreadyDownloading,
    isGpuVersion,
    isOfferedParakeet,
    modelKeys,
    type ParakeetModelInfo,
    parakeetModelsQuery,
    POST_CALL_WHISPER_MODEL,
    removeParakeetModel,
    removeWhisperModel,
    retryParakeetDownload,
    type SpeechModelStatus,
    uninstallOptionalModel,
    type WhisperModelInfo,
    whisperModelsQuery,
} from '@/api/models'
import {isWhisperProvider, postCallConfigQuery, speechKeys, transcriptConfigQuery} from '@/api/speech'
import {toast} from '@/components/ui/toastStore'

export type SpeechEngine = 'parakeet' | 'whisper'

export type SpeechModel =
    | (ParakeetModelInfo & {engine: 'parakeet', tier?: undefined, companion_of?: undefined})
    | (WhisperModelInfo & {engine: 'whisper'})

export const isInstalled = (status: SpeechModelStatus | undefined) => status === 'Available'

/** A copy that failed its size or integrity check: it is removed before it downloads again. */
export const isCorrupted = (status: SpeechModelStatus | undefined) => typeof status === 'object' && 'Corrupted' in status

/**
 * What a speech model is used for now: during meetings (the live model),
 * after them (the after-meeting model, or the live one it follows), or both.
 */
export function useModelUse() {
    const live = useQuery(transcriptConfigQuery).data
    const postCall = useQuery(postCallConfigQuery).data
    return (engine: SpeechEngine, name: string): string | null => {
        const liveEngine: SpeechEngine | null = live ? (isWhisperProvider(live.provider) ? 'whisper' : 'parakeet') : null
        const during = liveEngine === engine && live?.model === name
        const after = postCall?.provider === 'live' ? during : postCall?.provider === engine && postCall.model === name
        if (during && after) return 'In use during and after meetings'
        if (during) return 'In use during meetings'
        if (after) return 'In use after meetings'
        return null
    }
}

/** The speech models, the downloads the events report, and what to do with a model. */
export function useSpeechModels() {
    const queryClient = useQueryClient()
    const parakeet = useQuery(parakeetModelsQuery)
    const whisper = useQuery(whisperModelsQuery)
    const downloads = useQuery(downloadsQuery).data

    const refresh = () => {
        void queryClient.invalidateQueries({queryKey: modelKeys.all})
        void queryClient.invalidateQueries({queryKey: speechKeys.all})
    }
    // A download's failure comes as its error event, which its row shows; a
    // second click while it runs changes nothing.
    const quiet = (error: unknown) => {
        if (!isAlreadyDownloading(error)) console.warn('Speech model download:', error)
    }

    /** Downloads a model; `activate` makes Whisper Large V3 Turbo the after-meeting model natively once verified. */
    const download = (model: SpeechModel, {activate = false} = {}) => {
        const run = async () => {
            if (isCorrupted(model.status)) {
                await (model.engine === 'parakeet' ? removeParakeetModel(model.name) : removeWhisperModel(model.name))
            }
            const failed = downloads[downloadKey(model.engine, model.name)]?.state === 'failed'
            if (model.engine === 'parakeet') {
                await (failed ? retryParakeetDownload(model.name) : downloadParakeetModel(model.name))
            } else {
                await downloadWhisperModel(model.name, {enablePostCall: activate && model.name === POST_CALL_WHISPER_MODEL})
            }
        }
        void run().catch(quiet).finally(refresh)
    }

    const cancel = (model: SpeechModel) => {
        const stop = model.engine === 'parakeet' ? cancelParakeetDownload(model.name) : cancelWhisperDownload(model.name)
        void stop.catch((error) => toast.error('Couldn’t cancel the download', {description: errorMessage(error)}))
    }

    /**
     * Removes a model. Whisper Large V3 Turbo goes through native's optional
     * removal, which first puts back the choices that used it.
     */
    const remove = async (model: SpeechModel) => {
        try {
            if (model.engine === 'parakeet') await removeParakeetModel(model.name)
            else if (model.name === POST_CALL_WHISPER_MODEL) await uninstallOptionalModel('whisper')
            else await removeWhisperModel(model.name)
        } catch (error) {
            toast.error('Couldn’t remove the model', {description: errorMessage(error)})
        } finally {
            refresh()
        }
    }

    const parakeetModels: SpeechModel[] = (parakeet.data ?? [])
        .filter(({name}) => isOfferedParakeet(name))
        .map((model) => ({...model, engine: 'parakeet' as const}))
    const whisperModels = (whisper.data ?? []).map((model) => ({...model, engine: 'whisper' as const}))

    return {
        loading: parakeet.isPending || whisper.isPending,
        failed: parakeet.isError || whisper.isError,
        parakeet: parakeetModels,
        /** The regular Whisper models; the Intel GPU version is `gpuVersion`. */
        whisper: whisperModels.filter((model) => !isGpuVersion(model)),
        gpuVersion: whisperModels.find((model) => isGpuVersion(model)) ?? null,
        downloads,
        download,
        cancel,
        remove,
        refresh,
    }
}
