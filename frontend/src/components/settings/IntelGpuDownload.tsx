'use client';

/**
 * The running Intel download, for onboarding's download step (#88): Whisper's
 * Intel GPU version, or on a PC with only an Intel NPU, Intel's libraries
 * alone. Onboarding starts it with the pair it offered, and native code
 * finishes it (and makes the Intel GPU version the after-meeting model)
 * whether or not this screen stays open.
 */
import { invoke } from '@tauri-apps/api/core';
import { Progress } from '@/components/ui/progress';
import { formatModelSize } from '@/lib/model-catalog';
import { speechModelName } from '@/lib/speech-models';
import { cancelIntelLibraries, useIntelLibraries } from '@/hooks/useIntelLibraries';
import { DeviceBadge } from './ForThisComputer';
import type { SpeechChoice } from '@/hooks/useSpeechChoice';
import type { Device } from '@/lib/speech-choice';

function DownloadRow({ name, device, percent, label, onCancel }: { name: string; device: Device; percent: number; label: string; onCancel: () => void }) {
  return (
    <div className="rounded-lg border border-af-border bg-af-panel p-4 text-af-text">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          {name}
          <DeviceBadge device={device} />
        </span>
        <button type="button" className="text-xs text-af-text-2 hover:text-af-text" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <Progress className="mt-3" value={percent} aria-label={`Downloading ${name}`} />
      <p className="mt-1.5 text-xs tabular-nums text-af-text-3">{label}</p>
    </div>
  );
}

const bytesLabel = (done: number, total: number) => `Downloading · ${formatModelSize(done) || '0 MB'} of ${formatModelSize(total)}`;

export function IntelGpuDownload({ choice }: { choice: SpeechChoice }) {
  const libraries = useIntelLibraries();
  const gpu = choice.pair.after.gpu ? choice.companion : null;
  if (gpu && gpu.downloading !== null) {
    const version = choice.devices.gpuVersion;
    const progress = gpu.progress;
    return (
      <DownloadRow
        name={`Whisper ${version ? speechModelName('whisper', version.name, version.display_name) : 'Large V3 Turbo'}`}
        device="Intel GPU"
        percent={gpu.downloading}
        label={progress && progress.total > 0 ? bytesLabel(progress.done, progress.total) : `Downloading · ${Math.round(gpu.downloading)}%`}
        onCancel={() => void invoke('openvino_cancel', { id: gpu.id }).catch(() => {})}
      />
    );
  }
  if (!gpu && libraries.status === 'downloading') {
    return (
      <DownloadRow
        name="Intel's libraries for the NPU"
        device="Intel NPU"
        percent={libraries.total > 0 ? (libraries.done / libraries.total) * 100 : 0}
        label={libraries.total > 0 ? bytesLabel(libraries.done, libraries.total) : 'Downloading…'}
        onCancel={cancelIntelLibraries}
      />
    );
  }
  return null;
}
