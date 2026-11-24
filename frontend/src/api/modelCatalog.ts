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
