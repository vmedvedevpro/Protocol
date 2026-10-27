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
}

export const getCatalogStatus = () => invoke<CatalogStatus>('model_catalog_get_status');
export const checkForModelUpdates = () => invoke<CatalogStatus>('model_catalog_check_now');
export const startModelUpdate = (engine: CatalogEngine, id: string) =>
  invoke<CatalogStatus>('model_update_start', { engine, id });
export const cancelModelUpdate = (engine: CatalogEngine, id: string) =>
  invoke<CatalogStatus>('model_update_cancel', { engine, id });

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
 * fetched from main, or an update that ended. Progress does not change it.
 */
export function listKey(status: CatalogStatus | null): string {
  if (!status) return '';
  const running = status.operations.map((operation) => `${operation.engine}/${operation.id}`).sort().join(',');
  return `${status.source}|${status.fetchedAt ?? ''}|${running}`;
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
 */
export function useModelCatalog(onListChange?: () => void): CatalogStatus | null {
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const callback = useRef(onListChange);
  callback.current = onListChange;
  const key = useRef<string | null>(null);

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
