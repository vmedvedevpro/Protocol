import {useEffect, useMemo} from 'react'
import {type QueryClient, useQuery, useQueryClient} from '@tanstack/react-query'
import {
    builtInModelsQuery,
    downloadKey,
    type Downloads,
    downloadsQuery,
    isAlreadyDownloading,
    type ModelEngine,
    modelState,
    type ModelState,
    parakeetModelsQuery,
    recommendedSummaryModelQuery,
    type SpeechModelStatus,
    type BuiltInModelStatus,
    whisperModelsQuery,
} from '@/api/models'
import {errorMessage} from '@/api/core'
import {isFirstLaunchDone, onboardingStatusQuery} from '@/api/onboarding'
import {toast} from '@/components/ui/toastStore'
import {type FirstLaunchDownload, firstLaunchDownloads} from '../api/downloads'

/** A row's state: a model's, or `queued` while a download before it runs. */
export type RowState = ModelState | {kind: 'queued'}

export interface DownloadRow {
    download: FirstLaunchDownload
    state: RowState
}

type Lists = Partial<Record<ModelEngine, {name: string, status: SpeechModelStatus | BuiltInModelStatus}[]>>

const LISTS = {parakeet: parakeetModelsQuery, whisper: whisperModelsQuery, builtIn: builtInModelsQuery}

function stateOf(download: FirstLaunchDownload, lists: Lists, downloads: Downloads): ModelState {
    const status = lists[download.engine]?.find(({name}) => name === download.model)?.status
    return modelState(status, downloads[downloadKey(download.engine, download.model)])
}

// One run per window, kept by the app's QueryClient: it goes on after the
// screen closes, and each test, with its own client, gets its own.
const runs = new WeakMap<QueryClient, Promise<void>>()

/**
 * Starts the downloads one after another, skipping a model already
 * installed (a reinstall keeps the models folder). A failure moves on to the
 * next: its row offers Retry, or after first launch, when no row shows it, a
 * toast says so. Native code owns each download once started; one still
 * queued when the window reloads is not started, and Settings downloads it.
 */
function startDownloads(queryClient: QueryClient, downloads: FirstLaunchDownload[]) {
    if (runs.has(queryClient)) return
    runs.set(queryClient, (async () => {
        for (const download of downloads) {
            const lists: Lists = Object.fromEntries(
                Object.entries(LISTS).map(([engine, query]) => [engine, queryClient.getQueryData(query.queryKey)]),
            )
            const now = stateOf(download, lists, queryClient.getQueryData(downloadsQuery.queryKey) ?? {})
            if (now.kind === 'ready') continue
            try {
                await download.start()
            } catch (error) {
                // Running already (a window reloaded during first launch): native goes on with it.
                if (isAlreadyDownloading(error)) continue
                if (isFirstLaunchDone(queryClient.getQueryData(onboardingStatusQuery.queryKey))) {
                    toast.error(`Could not download ${download.detail}`, {description: errorMessage(error)})
                }
            }
        }
    })())
}

/**
 * The first launch downloads with their states, and the run that starts
 * them once the lists and the recommended summary model are known. `rows` is
 * empty until then.
 */
export function useFirstLaunchDownloads(): DownloadRow[] {
    const queryClient = useQueryClient()
    const recommended = useQuery(recommendedSummaryModelQuery)
    const parakeet = useQuery(parakeetModelsQuery)
    const whisper = useQuery(whisperModelsQuery)
    const builtIn = useQuery(builtInModelsQuery)
    const downloads = useQuery(downloadsQuery).data

    const summary = recommended.data
    const displayName = builtIn.data?.find(({name}) => name === summary)?.display_name
    const list = useMemo(
        () => (summary ? firstLaunchDownloads({name: summary, displayName: displayName ?? summary}) : []),
        [summary, displayName],
    )
    // A list that failed to load counts as read: the download reports its own failure.
    const listsRead = !parakeet.isPending && !whisper.isPending && !builtIn.isPending

    useEffect(() => {
        if (listsRead && list.length > 0) startDownloads(queryClient, list)
    }, [listsRead, list, queryClient])

    const lists: Lists = {parakeet: parakeet.data, whisper: whisper.data, builtIn: builtIn.data}
    const states = list.map((download) => stateOf(download, lists, downloads))
    return list.map((download, index) => {
        const state = states[index]
        // As the run goes: a missing model waits while one before it downloads.
        const behind = states.slice(0, index).some(({kind}) => kind === 'downloading' || kind === 'activating')
        return {download, state: state.kind === 'missing' && behind ? {kind: 'queued'} : state}
    })
}
