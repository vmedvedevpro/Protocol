// The model catalog and model updates (native: src-tauri/src/model_catalog/).
// Native code owns the catalog, the checks and every update; the WebView
// renders the status pushed as `model-catalog-changed` and calls the commands.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';

export const CATALOG_EVENT = 'model-catalog-changed';

export type CatalogEngine = 'whisper' | 'parakeet' | 'llama';

export interface ModelUpdate {
  engine: CatalogEngine;
  id: string;
  fromCommit: string;
  toCommit: string;
  downloadBytes: number;
}

export type UpdatePhase = 'downloading' | 'waiting' | 'testing' | 'installing';

export interface UpdateOperation {
  engine: CatalogEngine;
  id: string;
  phase: UpdatePhase;
  doneBytes: number;
  totalBytes: number;
}

export interface UpdateFailure {
  engine: CatalogEngine;
  id: string;
  message: string;
}

export interface CatalogStatus {
  source: 'remote' | 'cache' | 'built-in';
  fetchedAt: number | null;
  lastCheckedAt: number | null;
  checking: boolean;
  error: string | null;
  hidden: { index: number; id: string | null; problem: string }[];
  updates: ModelUpdate[];
  operations: UpdateOperation[];
  updateFailures: UpdateFailure[];
  /** Changes when model sizes read from Hugging Face changed. */
  sizesVersion: number;
}

export const getCatalogStatus = () => invoke<CatalogStatus>('model_catalog_get_status');
export const checkForModelUpdates = () => invoke<CatalogStatus>('model_catalog_check_now');
export const startModelUpdate = (engine: CatalogEngine, id: string) =>
  invoke<CatalogStatus>('model_update_start', { engine, id });
export const cancelModelUpdate = (engine: CatalogEngine, id: string) =>
  invoke<CatalogStatus>('model_update_cancel', { engine, id });
/**
 * Asks Hugging Face, in the background, for the sizes of `engine`'s listed
 * models (or of `ids` only) that are not known yet; `model-catalog-changed`
 * follows when they arrive, and the lists then show them.
 */
export const requestModelSizes = (engine: CatalogEngine, ids?: string[]) =>
  invoke<void>('model_catalog_request_sizes', { engine, ids: ids ?? null });
/** The size of one model in bytes: its installed files, else Hugging Face's listing; null while unknown. */
export const getModelSize = (engine: CatalogEngine, id: string) =>
  invoke<number | null>('model_catalog_model_size', { engine, id });

/**
 * A model size for display, from the bytes native code reports (Hugging
 * Face's listing, or an installed model's own files). Empty while the size is
 * unknown: a guess would only be wrong.
 */
export function formatModelSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '';
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(megabytes))} MB`;
}

export function onCatalogStatus(handler: (status: CatalogStatus) => void): Promise<UnlistenFn> {
  return listen<CatalogStatus>(CATALOG_EVENT, (event) => handler(event.payload));
}

const same = (engine: CatalogEngine, id: string) => (item: { engine: CatalogEngine; id: string }) =>
  item.engine === engine && item.id === id;

/** What a model's card shows about updates. */
export function modelUpdateState(status: CatalogStatus | null, engine: CatalogEngine, id: string) {
  return {
    operation: status?.operations.find(same(engine, id)) ?? null,
    update: status?.updates.find(same(engine, id)) ?? null,
    failure: status?.updateFailures.find(same(engine, id)) ?? null,
  };
}

/**
 * Changes when the models a manager lists may have changed: a catalog
 * fetched from main, an update that ended, or sizes read from Hugging Face.
 * Progress does not change it.
 */
export function listKey(status: CatalogStatus | null): string {
  if (!status) return '';
  const running = status.operations.map((operation) => `${operation.engine}/${operation.id}`).sort().join(',');
  return `${status.source}|${status.fetchedAt ?? ''}|${running}|${status.sizesVersion}`;
}

export function phaseLine(operation: UpdateOperation): string {
  switch (operation.phase) {
    case 'downloading': {
      const percent = operation.totalBytes > 0 ? Math.floor((operation.doneBytes / operation.totalBytes) * 100) : 0;
      return `Downloading the update… ${percent}%`;
    }
    case 'waiting':
      return 'Downloaded. The update installs once recordings, imports and summaries have finished.';
    case 'testing':
      return 'Checking that the new version loads…';
    case 'installing':
      return 'Installing the update…';
  }
}

export function sourceLine(status: CatalogStatus): string {
  switch (status.source) {
    case 'remote':
      return 'Model list from GitHub.';
    case 'cache':
      return 'Model list from the last check.';
    case 'built-in':
      return 'Model list built into this version.';
  }
}

/**
 * The catalog status, kept current from `model-catalog-changed`.
 * `onListChange` runs when the models a manager lists may have changed.
 * `sizesFor`: the engines whose model list is on screen; their missing sizes
 * are asked for once when it mounts.
 */
export function useModelCatalog(onListChange?: () => void, sizesFor: CatalogEngine[] = []): CatalogStatus | null {
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const callback = useRef(onListChange);
  callback.current = onListChange;
  const key = useRef<string | null>(null);
  const engines = sizesFor.join(',');

  useEffect(() => {
    if (!engines) return;
    for (const engine of engines.split(',') as CatalogEngine[]) {
      requestModelSizes(engine).catch(() => {});
    }
  }, [engines]);

  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | null = null;
    const apply = (next: CatalogStatus) => {
      if (!alive) return;
      setStatus(next);
      const nextKey = listKey(next);
      if (key.current !== null && key.current !== nextKey) callback.current?.();
      key.current = nextKey;
    };
    onCatalogStatus(apply)
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch(() => {});
    getCatalogStatus().then(apply).catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return status;
}

/**
 * The size of one model, for a line that names it outside a model list
 * (onboarding, optional downloads); null while unknown. Asks Hugging Face
 * for it when it is not known yet.
 */
export function useModelSize(engine: CatalogEngine, id: string | null | undefined): number | null {
  const status = useModelCatalog();
  const version = status?.sizesVersion ?? 0;
  const [bytes, setBytes] = useState<number | null>(null);

  useEffect(() => {
    if (id) requestModelSizes(engine, [id]).catch(() => {});
  }, [engine, id]);

  useEffect(() => {
    let alive = true;
    if (!id) {
      setBytes(null);
      return;
    }
    getModelSize(engine, id)
      .then((next) => {
        if (alive) setBytes(next ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [engine, id, version]);

  return bytes;
}
