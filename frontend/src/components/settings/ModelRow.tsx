'use client';

/**
 * One speech model in a Settings model list: what it is, whether it is on
 * this computer, and the one action that fits its state (download, cancel,
 * retry, remove). Choosing which model transcribes happens in the selects at
 * the top of Settings › Transcription, so a row never selects on click.
 */
import * as React from 'react';
import { Download } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Progress } from '@/components/ui/progress';
import { formatModelSize } from '@/lib/model-catalog';

export type ModelRowStatus =
  | 'Available'
  | 'Missing'
  | { Downloading: number }
  | { Error: string }
  | { Corrupted: unknown };

export interface ModelRowProps {
  name: string;
  description?: string | null;
  /** Short facts after the description (accuracy, speed, languages); empty ones are skipped. */
  facts?: Array<string | null | undefined | false>;
  status: ModelRowStatus;
  /** Bytes; unknown sizes are not shown (see formatModelSize). */
  sizeBytes?: number | null;
  recommended?: boolean;
  /** Where the installed model is in use, e.g. "Used after meetings". */
  usage?: string[];
  onDownload: () => void;
  onCancel: () => void;
  onRemove: () => void | Promise<void>;
  /** The model's update notice (ModelUpdateControl). */
  footer?: React.ReactNode;
}

export function ModelRow({
  name,
  description,
  facts = [],
  status,
  sizeBytes,
  recommended,
  usage = [],
  onDownload,
  onCancel,
  onRemove,
  footer,
}: ModelRowProps) {
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const size = formatModelSize(sizeBytes);
  const downloading = typeof status === 'object' && 'Downloading' in status ? status.Downloading : null;
  const error = typeof status === 'object' && 'Error' in status ? status.Error : null;
  const corrupted = typeof status === 'object' && 'Corrupted' in status;
  const installed = status === 'Available';
  const line = [description, size, ...facts].filter(Boolean).join(' · ');

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-af-text">{name}</span>
            {recommended && (
              <Badge variant="accent" size="xs">
                Recommended
              </Badge>
            )}
            {installed &&
              usage.map((use) => (
                <Badge key={use} variant="success" size="xs">
                  {use}
                </Badge>
              ))}
          </div>
          {line && <p className="mt-0.5 text-xs leading-relaxed text-af-text-3">{line}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {installed && (
            <>
              <span className="inline-flex items-center gap-1.5 pr-1 text-xs font-medium text-af-success">
                <span className="h-1.5 w-1.5 rounded-full bg-af-success" />
                Installed
              </span>
              <Button variant="ghost" size="xs" onClick={() => setConfirmRemove(true)} aria-label={`Remove ${name}`}>
                Remove
              </Button>
            </>
          )}
          {status === 'Missing' && (
            <Button variant="secondary" size="xs" onClick={onDownload} aria-label={`Download ${name}`}>
              <Download />
              Download
            </Button>
          )}
          {downloading !== null && (
            <Button variant="ghost" size="xs" onClick={onCancel} aria-label={`Cancel downloading ${name}`}>
              Cancel
            </Button>
          )}
          {error !== null && downloading === null && (
            <Button variant="secondary" size="xs" onClick={onDownload}>
              Retry
            </Button>
          )}
          {corrupted && (
            <>
              <Button variant="ghost" size="xs" onClick={() => setConfirmRemove(true)}>
                Remove
              </Button>
              <Button variant="secondary" size="xs" onClick={onDownload}>
                Download again
              </Button>
            </>
          )}
        </div>
      </div>

      {downloading !== null && (
        <div className="mt-2.5 space-y-1.5">
          <Progress value={downloading} aria-label={`Downloading ${name}`} />
          <p className="text-[11px] tabular-nums text-af-text-3">
            Downloading… {Math.round(downloading)}%
            {sizeBytes ? ` · ${formatModelSize((sizeBytes * downloading) / 100)} of ${size}` : ''}
          </p>
        </div>
      )}
      {error !== null && downloading === null && (
        <p role="alert" className="mt-2 text-xs text-af-danger [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      {corrupted && (
        <p className="mt-2 text-xs text-af-warning">The downloaded file is damaged. Download it again to use this model.</p>
      )}
      {footer}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${name}?`}
        description={`${size ? `This frees ${size}. ` : ''}You can download it again at any time.`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={onRemove}
      />
    </li>
  );
}

/** The bordered list the rows sit in. */
export function ModelList({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-af-border overflow-hidden rounded-xl border border-af-border bg-af-panel">
      {children}
    </ul>
  );
}
