'use client';

import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { relativeTime } from '@/lib/updater';
import { checkForModelUpdates, sourceLine, useModelCatalog, type CatalogStatus } from '@/lib/model-catalog';

/** The status line of the model list, per state. */
export function catalogLine(status: CatalogStatus, now = Date.now()): string {
  if (status.checking) return 'Checking for model updates…';
  const updates = status.updates.length;
  const found = updates === 0 ? 'Your models are up to date.' : `${updates} model update${updates === 1 ? '' : 's'} available on their cards in Settings › Transcription and Summaries.`;
  const checked = status.lastCheckedAt ? ` Last checked ${relativeTime(status.lastCheckedAt, now)}.` : ' Not checked yet.';
  return `${sourceLine(status)} ${status.lastCheckedAt ? found : ''}${checked}`.replace(/\s+/g, ' ').trim();
}

/** Settings › About: the model list and the Check for model updates button. */
export function ModelCatalogSettings() {
  const status = useModelCatalog();
  const [failed, setFailed] = useState<string | null>(null);
  if (!status) return null;

  const check = () => {
    setFailed(null);
    checkForModelUpdates()
      .then((next) => setFailed(next.error))
      .catch((error) => setFailed(String(error)));
  };

  // An entry that breaks several rules is listed once per problem.
  const hidden = new Set(status.hidden.map(({ index }) => index)).size;

  return (
    <section aria-labelledby="model-updates-heading" className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5 space-y-3">
      <div>
        <h4 id="model-updates-heading" className="text-sm font-semibold text-af-text">Models</h4>
        <p className="mt-1 flex items-center gap-2 text-[13px] text-af-text-3" role="status">
          {status.checking && <Spinner className="h-3.5 w-3.5" />}
          {catalogLine(status)}
        </p>
        {hidden > 0 && (
          <p className="mt-1 text-[12px] text-af-text-4">
            {hidden} entr{hidden === 1 ? 'y' : 'ies'} of the model list could not be used by this version.
          </p>
        )}
      </div>
      {failed && (
        <p role="alert" className="text-[13px] leading-relaxed text-af-danger">
          {failed}
        </p>
      )}
      <Button variant="secondary" size="sm" disabled={status.checking} onClick={check}>
        <RefreshCw className="h-3.5 w-3.5" />
        Check for model updates
      </Button>
    </section>
  );
}
