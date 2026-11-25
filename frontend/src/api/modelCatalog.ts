/**
 * The model catalog (src-tauri/src/model_catalog/): which speech and summary
 * models this version offers, and whether the installed ones changed on
 * Hugging Face. Native code owns the catalog, every check and every model
 * update, and pushes its whole status as `model-catalog-changed`. Mirrors
 * `Status` in model_catalog/service.rs.
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from './core'
import type {NativeEvent} from './events'

export type CatalogEngine = 'whisper' | 'parakeet' | 'llama'

/** An installed model with a newer revision on Hugging Face. */
export interface ModelUpdate {
    engine: CatalogEngine
    id: string
    fromCommit: string
    toCommit: string
    downloadBytes: number
}

export interface ModelUpdateOperation {
    engine: CatalogEngine
    id: string
    phase: 'downloading' | 'waiting' | 'testing' | 'installing'
    doneBytes: number
    totalBytes: number
}

export interface ModelFailure {
    engine: CatalogEngine
    id: string
    message: string
}

export interface CatalogStatus {
    /** Where the model list in use came from. */
    source: 'remote' | 'cache' | 'built-in'
    /** Unix time in milliseconds. */
    fetchedAt: number | null
    lastCheckedAt: number | null
    checking: boolean
    /** Why the last check failed, if it did. */
    error: string | null
    /** Entries of the list this version could not use, once per problem. */
    hidden: {index: number; id: string | null; problem: string}[]
    updates: ModelUpdate[]
    operations: ModelUpdateOperation[]
    updateFailures: ModelFailure[]
    /** Installed models Hugging Face answered the last check with an error for; they do not fail it. */
    checkFailures: ModelFailure[]
    /** Changes when model sizes read from Hugging Face changed. */
    sizesVersion: number
}

export const MODEL_CATALOG_CHANGED_EVENT = 'model-catalog-changed' as NativeEvent<CatalogStatus>

export const modelCatalogKeys = {
    all: ['modelCatalog'] as const,
    status: () => [...modelCatalogKeys.all, 'status'] as const,
}

/** Rejects while the catalog is still loading at startup. */
export const getCatalogStatus = () => command<CatalogStatus>('model_catalog_get_status')

export const catalogStatusQuery = queryOptions({
    queryKey: modelCatalogKeys.status(),
    queryFn: getCatalogStatus,
    // `model-catalog-changed` keeps it current (useEventQuerySync).
    staleTime: Infinity,
})

/**
 * Fetches the model list and compares the installed models with Hugging Face
 * now. Answers with the status after the check, `error` set if it failed;
 * the same status arrives as `model-catalog-changed`.
 */
export const checkForModelUpdates = () => command<CatalogStatus>('model_catalog_check_now')

// --- Per-model updates (Settings › Speech models) ----------------------------

/**
 * Starts the update of an installed model; native downloads it, waits for
 * work that must not be interrupted, tests it, then swaps it in. Answers the
 * status, which also arrives as `model-catalog-changed`.
 */
export const startModelUpdate = (engine: CatalogEngine, id: string) => command<CatalogStatus>('model_update_start', {engine, id})

/** Cancels an update before it installs. */
export const cancelModelUpdate = (engine: CatalogEngine, id: string) => command<CatalogStatus>('model_update_cancel', {engine, id})

/**
 * Asks native to read the sizes a shown list lacks from Hugging Face, in the
 * background; `sizesVersion` changes when they arrive, and the lists are read
 * again then.
 */
export const requestModelSizes = (engine: CatalogEngine, ids?: string[]) =>
    command<null>('model_catalog_request_sizes', {engine, ids: ids ?? null})

const same = (engine: CatalogEngine, id: string) => (item: {engine: CatalogEngine, id: string}) =>
    item.engine === engine && item.id === id

/** What a model's row shows about its update: the running one, the offer, the last failure, a failed check. */
export function modelUpdateState(status: CatalogStatus | null | undefined, engine: CatalogEngine, id: string) {
    return {
        operation: status?.operations.find(same(engine, id)) ?? null,
        update: status?.updates.find(same(engine, id)) ?? null,
        failure: status?.updateFailures.find(same(engine, id)) ?? null,
        checkFailure: status?.checkFailures.find(same(engine, id)) ?? null,
    }
}

/** A running update in words, its percent while it downloads. */
export function updatePhaseLine(operation: ModelUpdateOperation): string {
    switch (operation.phase) {
        case 'downloading':
            return 'Downloading the update'
        case 'waiting':
            return 'Downloaded. It installs once recordings, imports and summaries have finished'
        case 'testing':
            return 'Checking that the new version loads'
        case 'installing':
            return 'Installing the update'
    }
}
