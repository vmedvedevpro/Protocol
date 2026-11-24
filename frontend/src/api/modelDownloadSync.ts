import {type QueryKey, useQueryClient} from '@tanstack/react-query'
import {useNativeEvent} from './events'
import {
    BUILTIN_AI_DOWNLOAD_PROGRESS_EVENT,
    downloadKey,
    type DownloadState,
    downloadsQuery,
    isAlreadyDownloading,
    modelKeys,
    PARAKEET_DOWNLOAD_COMPLETE_EVENT,
    PARAKEET_DOWNLOAD_ERROR_EVENT,
    PARAKEET_DOWNLOAD_PROGRESS_EVENT,
    WHISPER_DOWNLOAD_ACTIVATING_EVENT,
    WHISPER_DOWNLOAD_COMPLETE_EVENT,
    WHISPER_DOWNLOAD_ERROR_EVENT,
    WHISPER_DOWNLOAD_PROGRESS_EVENT,
} from './models'

// Whisper reports a cancel as an error with this text; it is no failure.
const CANCELLED = /cancelled by user/i

/**
 * Keeps `downloadsQuery` from the model download events, and reads a
 * model's list again when its download ends, so it says Available. Mounted
 * once, by the shell (and by the stories of a screen that downloads), in
 * front of the startup gate: it hears the downloads
 * first launch starts and keeps hearing them after first launch is done.
 * Downloads that ran before the listener are in the lists' own status,
 * which it reads again once it listens.
 */
export function useModelDownloadSync() {
    const queryClient = useQueryClient()

    const set = (key: string, state: DownloadState | null) => {
        queryClient.setQueryData(downloadsQuery.queryKey, (downloads = {}) => {
            const {[key]: _previous, ...others} = downloads
            return state ? {...others, [key]: state} : others
        })
    }
    const refresh = (queryKey: QueryKey) => void queryClient.invalidateQueries({queryKey})
    // A download that ended leaves its record until the list says what it
    // left (Available, or Missing after a cancel): cleared first, the screen
    // would show the model missing for the moment between.
    const end = (key: string, list: QueryKey) =>
        void queryClient.invalidateQueries({queryKey: list}).then(() => set(key, null))

    useNativeEvent(
        PARAKEET_DOWNLOAD_PROGRESS_EVENT,
        ({modelName, progress, downloaded_mb, total_mb, speed_mbps, status}) => {
            const key = downloadKey('parakeet', modelName)
            if (status === 'cancelled') return end(key, modelKeys.parakeet())
            set(key, {state: 'downloading', progress, downloadedMb: downloaded_mb, totalMb: total_mb, speedMbps: speed_mbps})
        },
        // Downloads that ran before this listener are in the lists' status.
        {onListening: () => refresh(modelKeys.all)},
    )
    useNativeEvent(PARAKEET_DOWNLOAD_COMPLETE_EVENT, ({modelName}) => end(downloadKey('parakeet', modelName), modelKeys.parakeet()))
    useNativeEvent(PARAKEET_DOWNLOAD_ERROR_EVENT, ({modelName, error}) => {
        // A second call for a running download: native refuses it and says
        // so here too, while the first one goes on.
        if (isAlreadyDownloading(error)) return
        set(downloadKey('parakeet', modelName), {state: 'failed', error})
        refresh(modelKeys.parakeet())
    })

    useNativeEvent(WHISPER_DOWNLOAD_PROGRESS_EVENT, ({modelName, progress}) => {
        set(downloadKey('whisper', modelName), {state: 'downloading', progress})
    })
    useNativeEvent(WHISPER_DOWNLOAD_ACTIVATING_EVENT, ({modelName}) => {
        set(downloadKey('whisper', modelName), {state: 'activating'})
    })
    useNativeEvent(WHISPER_DOWNLOAD_COMPLETE_EVENT, ({modelName}) => end(downloadKey('whisper', modelName), modelKeys.whisper()))
    useNativeEvent(WHISPER_DOWNLOAD_ERROR_EVENT, ({modelName, error}) => {
        if (isAlreadyDownloading(error)) return
        const key = downloadKey('whisper', modelName)
        if (CANCELLED.test(error)) return end(key, modelKeys.whisper())
        set(key, {state: 'failed', error})
        refresh(modelKeys.whisper())
    })

    useNativeEvent(BUILTIN_AI_DOWNLOAD_PROGRESS_EVENT, ({model, progress, downloaded_mb, total_mb, speed_mbps, status, error}) => {
        const key = downloadKey('builtIn', model)
        if (status === 'downloading') {
            set(key, {state: 'downloading', progress, downloadedMb: downloaded_mb, totalMb: total_mb, speedMbps: speed_mbps})
            return
        }
        // The list and every readiness check under it.
        if (status !== 'error') return end(key, modelKeys.builtIn())
        if (isAlreadyDownloading(error)) return
        set(key, {state: 'failed', error: error ?? 'The download failed.'})
        refresh(modelKeys.builtIn())
    })
}
