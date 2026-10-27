'use client';

import React from 'react';
import { toast } from 'sonner';
import {
  cancelModelUpdate,
  formatModelSize,
  modelUpdateState,
  phaseLine,
  startModelUpdate,
  type CatalogEngine,
  type CatalogStatus,
} from '@/lib/model-catalog';

interface ModelUpdateControlProps {
  catalog: CatalogStatus | null;
  engine: CatalogEngine;
  id: string;
  /** Only an installed model can be updated. */
  installed: boolean;
}

/** The update notice of a model's card: offer, progress, or the last failure. */
export function ModelUpdateControl({ catalog, engine, id, installed }: ModelUpdateControlProps) {
  const { operation, update, failure } = modelUpdateState(catalog, engine, id);
  if (!installed || (!operation && !update && !failure)) return null;

  // The card selects its model on click; these controls must not.
  const run = (event: React.MouseEvent, action: () => Promise<unknown>) => {
    event.stopPropagation();
    action().catch((error) => toast.error('Model update', { description: String(error) }));
  };

  return (
    <div className="mt-3 border-t border-af-border pt-3 text-xs" onClick={(event) => event.stopPropagation()}>
      {operation ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-af-text-2" role="status">{phaseLine(operation)}</p>
          {operation.phase !== 'installing' && (
            <button
              type="button"
              className="rounded px-2 py-1 font-medium text-af-text-2 hover:bg-af-danger/10 hover:text-af-danger"
              onClick={(event) => run(event, () => cancelModelUpdate(engine, id))}
            >
              Cancel
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {failure && <p className="text-af-danger" role="alert">{failure.message}</p>}
            {update && !failure && (
              <p className="text-af-text-2">{formatModelSize(update.downloadBytes)
                  ? `Update available · ${formatModelSize(update.downloadBytes)} to download`
                  : 'Update available'}</p>
            )}
          </div>
          {update && (
            <button
              type="button"
              className="shrink-0 rounded px-2 py-1 font-medium text-af-accent hover:bg-af-accent/10"
              onClick={(event) => run(event, () => startModelUpdate(engine, id))}
            >
              {failure ? 'Try again' : 'Update'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
