'use client';

import { ArrowUpCircle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Hint } from '@/components/ui/tooltip';
import { useUpdater } from '@/contexts/UpdaterContext';
import { downloadPercent, type UpdaterSnapshot } from '@/lib/updater';
import { cn } from '@/lib/utils';
import { UpdatePanel } from './UpdatePanel';

/** The pill's words; null hides it. */
export function indicatorLabel(status: UpdaterSnapshot | null | undefined): string | null {
  const offer = status?.offer;
  if (!status || !offer) return null;
  const { version } = offer.release;
  const failed = status.error && !status.error.background && status.error.action !== 'check';
  if (failed) return `Update failed · ${version}`;
  if (status.activity.state === 'downloading') {
    const percent = downloadPercent(status.activity);
    return percent === null ? `Downloading · ${version}` : `Downloading · ${percent}%`;
  }
  if (offer.downloaded) return `Restart and update · ${version}`;
  return `Update available · ${version}`;
}

/**
 * Sidebar footer, above Settings: shown only while a release is offered. The
 * collapsed rail shows an icon with a dot and the label as its tooltip.
 */
export function UpdateIndicator({ expanded }: { expanded: boolean }) {
  const updater = useUpdater();
  const label = indicatorLabel(updater?.status);
  if (!updater || !label) return null;
  const { panelOpen, setPanelOpen } = updater;
  const failed = label.startsWith('Update failed');

  const trigger = (
    <PopoverTrigger asChild>
      <button
        type="button"
        aria-label={label}
        className={cn(
          'flex h-9 w-full items-center overflow-hidden rounded-lg text-[13px] font-medium transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-af-accent/60',
          failed ? 'bg-af-danger/[0.12] text-af-danger hover:bg-af-danger/20' : 'bg-af-accent/[0.14] text-af-accent hover:bg-af-accent/[0.22]',
        )}
      >
        <span className="relative flex h-full w-10 shrink-0 items-center justify-center [&_svg]:size-[18px]">
          <ArrowUpCircle />
          {!expanded && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
        </span>
        {expanded && <span className="min-w-0 flex-1 truncate pr-3 text-left">{label}</span>}
      </button>
    </PopoverTrigger>
  );

  return (
    <div className="pb-1.5">
      <Popover open={panelOpen} onOpenChange={setPanelOpen}>
        {expanded ? trigger : <Hint label={label} side="right">{trigger}</Hint>}
        <PopoverContent side="right" align="end" sideOffset={10} className="w-[22rem]">
          <UpdatePanel onClose={() => setPanelOpen(false)} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
