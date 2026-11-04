'use client';

/**
 * The running download of Whisper's Intel GPU version, for onboarding's
 * download step (#88): onboarding starts it with the pair it offered, and
 * native code finishes it (and makes it the after-meeting model) whether or
 * not this screen stays open.
 */
import { invoke } from '@tauri-apps/api/core';
import { Progress } from '@/components/ui/progress';
import { formatModelSize } from '@/lib/model-catalog';
import { speechModelName } from '@/lib/speech-models';
import { DeviceBadge } from './ForThisComputer';
import type { SpeechChoice } from '@/hooks/useSpeechChoice';

export function IntelGpuDownload({ choice }: { choice: SpeechChoice }) {
  const gpu = choice.pair.after.gpu ? choice.companion : null;
  if (!gpu || gpu.downloading === null) return null;
  const version = choice.devices.gpuVersion;
  const name = `Whisper ${version ? speechModelName('whisper', version.name, version.display_name) : 'Large V3 Turbo'}`;
  const progress = gpu.progress;
  const label = progress && progress.total > 0
    ? `Downloading · ${formatModelSize(progress.done) || '0 MB'} of ${formatModelSize(progress.total)}`
    : `Downloading · ${Math.round(gpu.downloading)}%`;
  return (
    <div className="rounded-lg border border-af-border bg-af-panel p-4 text-af-text">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          {name}
          <DeviceBadge device="Intel GPU" />
        </span>
        <button
          type="button"
          className="text-xs text-af-text-2 hover:text-af-text"
          onClick={() => void invoke('openvino_cancel', { id: gpu.id }).catch(() => {})}
        >
          Cancel
        </button>
      </div>
      <Progress className="mt-3" value={gpu.downloading} aria-label="Downloading Whisper for the Intel GPU" />
      <p className="mt-1.5 text-xs tabular-nums text-af-text-3">{label}</p>
    </div>
  );
}
