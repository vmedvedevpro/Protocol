import {type QueryClient, type QueryKey, useQueryClient} from '@tanstack/react-query'
import {DIARIZATION_DOWNLOAD_PROGRESS_EVENT, DIARIZATION_ENGINE_CHANGED_EVENT, diarizationKeys, NEMOTRON} from './diarization'
import {useEventQuerySync, useNativeEvent} from './events'
import {
    companionQuery,
    INTEL_LIBRARIES_ID,
    intelError,
    intelKeys,
    isIntelCancelled,
    NPU_STATUS_EVENT,
    npuQuery,
    OPENVINO_COMPANION_CHANGED_EVENT,
    OPENVINO_RUNTIME_PROGRESS_EVENT,
} from './intel'
import {catalogStatusQuery, MODEL_CATALOG_CHANGED_EVENT} from './modelCatalog'
import {
    BUILTIN_AI_DOWNLOAD_PROGRESS_EVENT,
    downloadKey,
    type DownloadState,
    downloadsQuery,
    isAlreadyDownloading,
    modelKeys,
    OPTIONAL_MODEL_REMOVED_EVENT,
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

function setDownload(queryClient: QueryClient, key: string, state: DownloadState | null) {
    queryClient.setQueryData(downloadsQuery.queryKey, (downloads = {}) => {
        const {[key]: _previous, ...others} = downloads
        return state ? {...others, [key]: state} : others
    })
}

/**
 * Runs an Intel download (the Intel GPU version, or Intel's libraries
 * alone) and keeps its record in `downloadsQuery`. Native sends their
 * progress by event but no event when one fails, so the command's rejection
 * is the only word of a failure: it is written here in the UI's words
 * (`intelError`), and a cancel clears the record. Rejects as the command
 * does, a cancel included.
 */
export async function trackIntelDownload(queryClient: QueryClient, engine: 'intelGpu' | 'intelLibraries', id: string, run: () => Promise<unknown>) {
    const key = downloadKey(engine, id)
    const current = queryClient.getQueryData(downloadsQuery.queryKey)?.[key]
    if (current?.state !== 'downloading') setDownload(queryClient, key, {state: 'downloading', progress: 0})
    const reread = () => Promise.all([
        queryClient.invalidateQueries({queryKey: intelKeys.all}),
        queryClient.invalidateQueries({queryKey: modelKeys.whisper()}),
    ]).catch(() => undefined)
    try {
        await run()
    } catch (error) {
        setDownload(queryClient, key, isIntelCancelled(error) ? null : {state: 'failed', error: intelError(error)})
        void reread()
        throw error
    }
    // The record goes once the statuses say installed, so a row never drops
    // from 99 % to "not downloaded" while they are read again.
    await reread()
    setDownload(queryClient, key, null)
}

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

    const set = (key: string, state: DownloadState | null) => setDownload(queryClient, key, state)
    const downloads = () => queryClient.getQueryData(downloadsQuery.queryKey) ?? {}
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

    // Nemotron: native activates it after its download and says so.
    useNativeEvent(DIARIZATION_DOWNLOAD_PROGRESS_EVENT, ({percent, status, message}) => {
        const key = downloadKey('nemotron', NEMOTRON)
        if (status === 'done' || status === 'cancelled') return end(key, diarizationKeys.status())
        if (status === 'error') {
            set(key, {state: 'failed', error: message ?? 'The download failed.'})
            return refresh(diarizationKeys.status())
        }
        set(key, {state: 'downloading', progress: percent})
    })
    useNativeEvent(DIARIZATION_ENGINE_CHANGED_EVENT, () => refresh(diarizationKeys.status()))

    // A removal puts the choices back natively; the lists say what is left.
    useNativeEvent(OPTIONAL_MODEL_REMOVED_EVENT, (model) => {
        refresh(model === 'nemotron' ? diarizationKeys.status() : modelKeys.whisper())
        if (model === 'whisper') refresh(intelKeys.all)
    })

    // The Intel GPU version reports its percent in its status, which this
    // event says changed: read it, and keep its record from it.
    useNativeEvent(OPENVINO_COMPANION_CHANGED_EVENT, () => {
        void (async () => {
            await queryClient.invalidateQueries({queryKey: intelKeys.all})
            const companion = await queryClient.fetchQuery(companionQuery).catch(() => null)
            if (!companion) return
            const key = downloadKey('intelGpu', companion.id)
            if (companion.downloading !== null) {
                set(key, {state: 'downloading', progress: companion.downloading})
            } else if (downloads()[key]?.state === 'downloading') {
                // Ended: installed, or cancelled or failed, which its caller records.
                if (companion.installed) set(key, null)
                refresh(modelKeys.whisper())
            }
            if (companion.runtime?.installed) set(downloadKey('intelLibraries', INTEL_LIBRARIES_ID), null)
        })()
    })
    useNativeEvent(OPENVINO_RUNTIME_PROGRESS_EVENT, ({done, total}) => {
        // The libraries are also part of the Intel GPU version's download, which keeps its own record.
        if (Object.entries(downloads()).some(([key, state]) => key.startsWith('intelGpu:') && state.state === 'downloading')) return
        const key = downloadKey('intelLibraries', INTEL_LIBRARIES_ID)
        if (downloads()[key]?.state !== 'downloading') return
        set(key, {state: 'downloading', progress: total > 0 ? Math.floor((done / total) * 100) : 0})
    })
    useEventQuerySync(NPU_STATUS_EVENT, npuQuery.queryKey)
    useNativeEvent(NPU_STATUS_EVENT, ({state}) => {
        // The NPU has its libraries: their download alone is over.
        if (state !== 'needs_runtime') set(downloadKey('intelLibraries', INTEL_LIBRARIES_ID), null)
    })

    // Model updates: the status line shows them too, and an update that
    // ended changes a list.
    useEventQuerySync(MODEL_CATALOG_CHANGED_EVENT, catalogStatusQuery.queryKey)
    useNativeEvent(MODEL_CATALOG_CHANGED_EVENT, ({operations}) => {
        if (operations.length === 0) {
            refresh(modelKeys.parakeet())
            refresh(modelKeys.whisper())
        }
    })
}
