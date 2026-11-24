import {emit} from '@tauri-apps/api/event'
import {type CatalogStatus, MODEL_CATALOG_CHANGED_EVENT} from '@/api/modelCatalog'
import type {MockHandler} from './handlers'

// How long a check takes, so "Checking…" shows in pnpm dev; tests skip it.
const CHECK_MS = import.meta.env.MODE === 'test' ? 0 : 900

/** The list built into this version, never checked: what a fresh install reports. */
export function createMockCatalog(): CatalogStatus {
    return {
        source: 'built-in',
        fetchedAt: null,
        lastCheckedAt: null,
        checking: false,
        error: null,
        hidden: [],
        updates: [],
        operations: [],
        updateFailures: [],
        checkFailures: [],
        sizesVersion: 0,
    }
}

/**
 * `model_catalog_get_status` and `model_catalog_check_now`
 * (model_catalog/commands.rs), spread into `handlers` with the mock state.
 * A check finds the list on GitHub and every model up to date; it pushes
 * `model-catalog-changed` as it starts and as it ends.
 */
export function modelCatalogHandlers(state: {catalog: CatalogStatus}): Record<string, MockHandler> {
    const publish = (patch: Partial<CatalogStatus>) => {
        state.catalog = {...state.catalog, ...patch}
        emit(MODEL_CATALOG_CHANGED_EVENT, state.catalog).catch(() => undefined)
        return state.catalog
    }
    return {
        model_catalog_get_status: () => state.catalog,
        model_catalog_check_now: async () => {
            const checking = publish({checking: true, error: null})
            await new Promise((resolve) => setTimeout(resolve, CHECK_MS))
            // A reset or another change meanwhile: leave it.
            if (state.catalog !== checking) return state.catalog
            const now = Date.now()
            return publish({checking: false, source: 'remote', fetchedAt: now, lastCheckedAt: now})
        },
    }
}
