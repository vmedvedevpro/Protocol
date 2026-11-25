import {useEffect, useMemo} from 'react'
import {type QueryClient, useQuery, useQueryClient} from '@tanstack/react-query'
import {
    type CompanionStatus,
    companionQuery,
    gpuOffered,
    INTEL_LIBRARIES_ID,
    npuQuery,
    openVinoAvailabilityQuery,
    type ParakeetNpuStatus,
} from '@/api/intel'
import {trackIntelDownload} from '@/api/modelDownloadSync'
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
import {shortModelName} from '@/api/summaryProviders'
import {toast} from '@/components/ui/toastStore'
import {type FirstLaunchDownload, firstLaunchDownloads, summaryDownload} from '../api/downloads'

/** A row's state: a model's, or `queued` while a download before it runs. */
export type RowState = ModelState | {kind: 'queued'}

export interface DownloadRow {
    download: FirstLaunchDownload
    state: RowState
}

type Lists = Partial<Record<ModelEngine, {name: string, status: SpeechModelStatus | BuiltInModelStatus}[]>>

const LISTS = {parakeet: parakeetModelsQuery, whisper: whisperModelsQuery}

/**
 * The Intel downloads as lists: the Intel GPU version is installed with
 * its libraries; Intel's libraries are, for a present NPU, once it no
 * longer waits for them (native checks them before Parakeet).
 */
function intelLists(companion: CompanionStatus | null | undefined, npu: ParakeetNpuStatus | undefined): Lists {
    const libraries = !!npu?.present && npu.state !== 'needs_runtime'
    return {
        intelGpu: companion ? [{name: companion.id, status: companion.installed ? 'Available' : 'Missing'}] : [],
        intelLibraries: [{name: INTEL_LIBRARIES_ID, status: libraries ? 'Available' : 'Missing'}],
    }
}

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
            const lists: Lists = {
                ...Object.fromEntries(Object.entries(LISTS).map(([engine, query]) => [engine, queryClient.getQueryData(query.queryKey)])),
                ...intelLists(queryClient.getQueryData(companionQuery.queryKey), queryClient.getQueryData(npuQuery.queryKey)),
            }
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
 * The speech downloads with their states, and the run that starts them once
 * the lists and this computer's Intel hardware are known. `rows` is empty
 * until then. The hardware path rests on facts that hold for the run (an
 * Intel GPU is offered its version, an NPU is present), so the list keeps
 * its rows as they finish.
 */
export function useFirstLaunchDownloads(): DownloadRow[] {
    const queryClient = useQueryClient()
    const parakeet = useQuery(parakeetModelsQuery)
    const whisper = useQuery(whisperModelsQuery)
    const availability = useQuery(openVinoAvailabilityQuery)
    const companion = useQuery(companionQuery)
    const npu = useQuery(npuQuery)
    const downloads = useQuery(downloadsQuery).data

    // The Intel queries answer null (or no NPU) where there is nothing, so pending is the only wait.
    const hardwareRead = !availability.isPending && !companion.isPending && !npu.isPending
    const gpuVersion = gpuOffered(availability.data, companion.data) ? companion.data.id : null
    const npuLibraries = !!npu.data?.present
    const list = useMemo(
        () => (hardwareRead
            ? firstLaunchDownloads({
                gpuVersion,
                npuLibraries,
                track: (engine, id, run) => trackIntelDownload(queryClient, engine, id, run),
            })
            : []),
        [hardwareRead, gpuVersion, npuLibraries, queryClient],
    )
    // A list that failed to load counts as read: the download reports its own failure.
    const listsRead = !parakeet.isPending && !whisper.isPending

    useEffect(() => {
        if (listsRead && list.length > 0) startDownloads(queryClient, list)
    }, [listsRead, list, queryClient])

    const lists: Lists = {parakeet: parakeet.data, whisper: whisper.data, ...intelLists(companion.data, npu.data)}
    const states = list.map((download) => stateOf(download, lists, downloads))
    return list.map((download, index) => {
        const state = states[index]
        // As the run goes: a missing model waits while one before it downloads.
        const behind = states.slice(0, index).some(({kind}) => kind === 'downloading' || kind === 'activating')
        return {download, state: state.kind === 'missing' && behind ? {kind: 'queued'} : state}
    })
}

/**
 * The recommended built-in summary model as a row, downloaded only when the
 * user installs it; null until the recommendation and the list are known.
 * Its progress and failure come through `downloadsQuery`, which outlives the
 * screen, as in Settings.
 */
export function useSummaryDownload(): DownloadRow | null {
    const recommended = useQuery(recommendedSummaryModelQuery).data
    const builtIn = useQuery(builtInModelsQuery).data
    const downloads = useQuery(downloadsQuery).data
    const entry = builtIn?.find(({name}) => name === recommended)
    const [name, displayName, sizeBytes] = [entry?.name, entry?.display_name, entry?.size_bytes ?? null]
    const download = useMemo(
        () => (name && displayName ? summaryDownload({name, displayName: shortModelName(displayName), sizeBytes}) : null),
        [name, displayName, sizeBytes],
    )
    if (!download) return null
    return {download, state: stateOf(download, {builtIn}, downloads ?? {})}
}
