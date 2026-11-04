'use client';

/**
 * Settings › Transcription › Speech models › For this computer (#88, mockups
 * N1, N3, N4, N6, N7): the pair `lib/speech-choice.ts` picks, Parakeet for
 * live text and Whisper Large V3 Turbo after meetings, each with the device
 * it runs on. One button downloads what is missing; each row shows its own
 * progress, Installed and Remove, and says when its device did not start.
 *
 * Whisper's Intel GPU version is not a model of its own here: it is
 * "Whisper Large V3 Turbo" with an "Intel GPU" badge. Its download (Intel's
 * libraries with the model) is `openvino_download` with `choose`, which makes
 * it the after-meeting model in native code when it ends.
 */
import { useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Cpu, Download, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Progress } from '@/components/ui/progress';
import { useOptionalModelDownloads } from '@/contexts/OptionalModelDownloadsContext';
import { formatModelSize } from '@/lib/model-catalog';
import { getModelDisplayInfo } from '@/lib/parakeet';
import { npuNote, parakeetLine, sumBytes, type Device } from '@/lib/speech-choice';
import { speechModelDescription, speechModelLanguages, speechModelName } from '@/lib/speech-models';
import type { SpeechChoice } from '@/hooks/useSpeechChoice';
import { runtimeUpdate, type CompanionStatus } from '@/lib/intel-gpu';

// The native message of a cancelled Intel GPU download (model_catalog/runtime.rs).
const CANCELLED = 'The download was cancelled';

export function DeviceBadge({ device }: { device: Device }) {
  const Icon = device === 'Intel NPU' ? Share2 : Cpu;
  return (
    <Badge variant="neutral" size="xs" className="gap-1 align-middle">
      <Icon className="h-3 w-3" aria-hidden />
      {device}
    </Badge>
  );
}

/** The toast after the Intel GPU version installed, from its status asked again then. */
export function gpuInstalledNotice(companion: CompanionStatus | null): { title: string; description: string } {
  if (companion?.runtime?.afterRestart) {
    return { title: "Intel's libraries are updated", description: 'Whisper uses them after Protocol restarts.' };
  }
  if (companion?.stopped) {
    return { title: 'The Intel GPU version is installed', description: 'Try the Intel GPU again in Settings › Transcription to use it.' };
  }
  return { title: 'Whisper is ready for the Intel GPU', description: 'Transcripts after meetings use it from the next one on.' };
}

type RowState =
  | { kind: 'missing' }
  | { kind: 'installed' }
  | { kind: 'downloading'; percent: number; done?: number; total?: number; label?: string }
  | { kind: 'preparing' };

interface RowProps {
  name: string;
  use: string;
  device: Device | null;
  line: string;
  state: RowState;
  /** One model missing alone gets its own button; with both missing the header's downloads them. */
  download?: { label: string; onClick: () => void } | null;
  onCancel?: () => void;
  onRemove?: () => void | Promise<void>;
  removeSize?: string;
  children?: ReactNode;
}

function PairRow({ name, use, device, line, state, download, onCancel, onRemove, removeSize, children }: RowProps) {
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-af-text">{name}</span>
            <Badge variant="success" size="xs">{use}</Badge>
            {device && <DeviceBadge device={device} />}
          </div>
          {line && <p className="mt-0.5 text-xs leading-relaxed text-af-text-3">{line}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state.kind === 'installed' && (
            <>
              <span className="inline-flex items-center gap-1.5 pr-1 text-xs font-medium text-af-success">
                <span className="h-1.5 w-1.5 rounded-full bg-af-success" />
                Installed
              </span>
              {onRemove && (
                <Button variant="ghost" size="xs" onClick={() => setConfirm(true)} aria-label={`Remove ${name}`}>
                  Remove
                </Button>
              )}
            </>
          )}
          {state.kind === 'downloading' && (
            <>
              <div className="flex w-44 flex-col items-end gap-1.5">
                <span className="text-[11px] tabular-nums text-af-text-3">
                  {state.label ?? (state.done !== undefined && state.total
                    ? `Downloading · ${formatModelSize(state.done) || '0 MB'} of ${formatModelSize(state.total)}`
                    : `Downloading · ${Math.round(state.percent)}%`)}
                </span>
                <Progress value={state.percent} aria-label={`Downloading ${name}`} />
              </div>
              {onCancel && (
                <Button variant="ghost" size="xs" onClick={onCancel} aria-label={`Cancel downloading ${name}`}>
                  Cancel
                </Button>
              )}
            </>
          )}
          {state.kind === 'preparing' && (
            <div className="flex w-44 flex-col items-end gap-1.5">
              <span className="text-[11px] text-af-text-3">Preparing · about 2 min</span>
              <div role="progressbar" aria-label="Preparing Parakeet for the Intel NPU" className="relative h-1.5 w-full overflow-hidden rounded-full bg-af-text/[0.08]">
                <div className="absolute inset-y-0 left-1/4 w-1/3 animate-pulse rounded-full bg-af-accent" />
              </div>
            </div>
          )}
          {state.kind === 'missing' && download && (
            <Button variant="secondary" size="xs" onClick={download.onClick}>
              <Download />
              {download.label}
            </Button>
          )}
        </div>
      </div>
      {children}
      {onRemove && (
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title={`Remove ${name}?`}
          description={`${removeSize ? `This frees ${removeSize}. ` : ''}You can download it again at any time.`}
          confirmLabel="Remove"
          variant="danger"
          onConfirm={onRemove}
        />
      )}
    </li>
  );
}

/** A device that did not start (N6): what runs instead, and Try again. */
function Notice({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <div role="status" className="mt-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-lg border border-af-warning/30 bg-af-warning/[0.08] px-3 py-2 text-xs text-af-text">
      <span className="min-w-0 flex-1 basis-60 [overflow-wrap:anywhere]">{children}</span>
      <span className="flex shrink-0 items-center gap-1">{actions}</span>
    </div>
  );
}

const noticeButton = 'shrink-0 rounded px-1.5 py-1 font-semibold text-af-warning hover:bg-af-warning/10';

export interface ForThisComputerProps {
  choice: SpeechChoice;
  /** A finished Parakeet download becomes the live model. */
  onParakeetInstalled: (name: string) => void | Promise<unknown>;
  /** A model was removed or downloaded: the selects list the models again. */
  onModelsChanged: () => void;
  /** The update offer was put off but still applies: a small way back to it. */
  offerBack?: { label: string; onClick: () => void } | null;
}

export function ForThisComputer({ choice, onParakeetInstalled, onModelsChanged, offerBack }: ForThisComputerProps) {
  const { jobs, startDownload, uninstallModel } = useOptionalModelDownloads();
  const [errors, setErrors] = useState<{ live?: string; after?: string; runtime?: string }>({});
  const [runtimeDownloading, setRuntimeDownloading] = useState(false);
  const [gpuRetried, setGpuRetried] = useState(false);
  const { pair, companion, npu } = choice;

  // --- Live: Parakeet ---
  const parakeet = choice.parakeet.find((model) => model.name === pair.live.id);
  const parakeetName = `Parakeet ${speechModelName('parakeet', pair.live.id, parakeet?.display_name || getModelDisplayInfo(pair.live.id)?.friendlyName)}`;
  const parakeetInstalled = parakeet?.status === 'Available';
  const parakeetStatusPercent = parakeet && typeof parakeet.status === 'object' && 'Downloading' in parakeet.status
    ? Number((parakeet.status as { Downloading: unknown }).Downloading) || 0
    : null;
  const parakeetPercent = choice.parakeetProgress[pair.live.id] ?? parakeetStatusPercent;
  const parakeetSize = parakeet?.size_bytes ?? null;
  const npuFailed = npu.present && npu.state === 'failed';
  const liveDevice = npuFailed ? null : pair.live.device;
  const liveState: RowState = parakeetPercent !== null && !parakeetInstalled
    ? { kind: 'downloading', percent: parakeetPercent, done: parakeetSize ? (parakeetSize * parakeetPercent) / 100 : undefined, total: parakeetSize ?? undefined }
    : parakeetInstalled && npu.present && npu.state === 'preparing'
      ? { kind: 'preparing' }
      : parakeetInstalled ? { kind: 'installed' } : { kind: 'missing' };

  // --- After meetings: Whisper Large V3 Turbo, its Intel GPU version or the regular copy ---
  const copy = choice.whisper.find((model) => model.name === pair.copy);
  const copyInstalled = copy?.status === 'Available';
  const copySize = copy?.size_bytes ?? null;
  const turboName = `Whisper ${speechModelName('whisper', pair.copy, copy?.display_name)}`;
  const gpuName = choice.devices.gpuVersion
    ? `Whisper ${speechModelName('whisper', choice.devices.gpuVersion.name, choice.devices.gpuVersion.display_name)}`
    : 'Whisper Large V3 Turbo';
  const gpu = pair.after.gpu && companion ? companion : null;
  const gpuInstalled = !!gpu?.installed;
  const fellBack = gpu && gpuInstalled && !gpuRetried ? choice.devices.gpuFallback : null;
  const copyJob = jobs.whisper;
  const copyDownloading = copyJob.status === 'downloading' || copyJob.status === 'activating';
  const languages = speechModelLanguages(copy?.languages ?? ['*']);

  const downloadParakeet = async () => {
    setErrors((previous) => ({ ...previous, live: undefined }));
    try {
      await invoke('parakeet_download_model', { modelName: pair.live.id });
      await onParakeetInstalled(pair.live.id);
    } catch (error) {
      const message = String(error);
      if (!/cancel/i.test(message)) setErrors((previous) => ({ ...previous, live: message }));
    }
    choice.refresh();
    onModelsChanged();
  };

  // `choose`: the download makes it the after-meeting model; an update of
  // Intel's libraries leaves the choice alone.
  const downloadGpu = async (choose = true) => {
    if (!gpu) return;
    setErrors((previous) => ({ ...previous, after: undefined }));
    try {
      await invoke('openvino_download', { id: gpu.id, choose });
      const status = await invoke<CompanionStatus | null>('openvino_status', { whisperModel: pair.copy }).catch(() => null);
      const notice = gpuInstalledNotice(status);
      toast.success(notice.title, { description: notice.description });
    } catch (error) {
      const message = String(error);
      if (message !== CANCELLED) setErrors((previous) => ({ ...previous, after: message }));
    }
    choice.refresh();
    onModelsChanged();
  };

  // The NPU alone needs Intel's libraries; with the Intel GPU version they come with it.
  const runtimeWanted = npu.present && npu.state === 'needs_runtime' && !gpu;
  const downloadRuntime = async () => {
    setErrors((previous) => ({ ...previous, runtime: undefined }));
    setRuntimeDownloading(true);
    try {
      await invoke('openvino_runtime_download');
    } catch (error) {
      const message = String(error);
      if (message !== CANCELLED) setErrors((previous) => ({ ...previous, runtime: message }));
    } finally {
      setRuntimeDownloading(false);
      choice.refresh();
    }
  };

  // The regular copy as the after-meeting model (N7): the optional Whisper job
  // makes it that natively. As the fallback of the Intel GPU version (N6) it
  // must not take over the choice, so it is a plain download.
  const downloadCopy = (asFallback: boolean) => {
    if (asFallback) {
      void invoke('whisper_download_model', { modelName: pair.copy, enablePostCall: false })
        .catch((error) => setErrors((previous) => ({ ...previous, after: String(error) })))
        .finally(() => { choice.refresh(); onModelsChanged(); });
    } else {
      startDownload('whisper');
    }
  };

  const afterMissing = gpu ? !gpuInstalled && gpu.downloading === null : !copyInstalled && !copyDownloading;
  const liveMissing = liveState.kind === 'missing';
  // With both missing the header's button downloads them; otherwise the missing row has its own.
  const both = liveMissing && afterMissing;
  const downloadAfter = () => (gpu ? void downloadGpu() : downloadCopy(false));
  const afterBytes = gpu ? gpu.downloadSize : copySize;
  const runtimeBytes = runtimeWanted ? companion?.runtime?.downloadSize ?? null : null;
  const bothBytes = sumBytes([parakeetSize, afterBytes, ...(runtimeWanted ? [runtimeBytes] : [])]);
  const downloadBoth = () => {
    void downloadParakeet();
    downloadAfter();
    if (runtimeWanted) void downloadRuntime();
  };

  const removeParakeet = async () => {
    try {
      await invoke('parakeet_delete_corrupted_model', { modelName: pair.live.id });
    } catch (error) {
      toast.error(`Could not remove ${parakeetName}`, { description: String(error) });
    }
    choice.refresh();
    onModelsChanged();
  };
  const removeGpu = async () => {
    if (!gpu) return;
    try {
      await invoke('speech_choice_remove_gpu_version', { id: gpu.id });
    } catch (error) {
      toast.error(`Could not remove ${gpuName}`, { description: String(error) });
    }
    choice.refresh();
    onModelsChanged();
  };
  const cancelGpu = () => { if (gpu) void invoke('openvino_cancel', { id: gpu.id }).catch(() => {}); };
  const cancelParakeet = () => { void invoke('parakeet_cancel_download', { modelName: pair.live.id }).catch(() => {}); };
  const cancelCopy = () => { void invoke('whisper_cancel_download', { modelName: pair.copy }).catch(() => {}); };
  const retryNpu = () => { void invoke('parakeet_npu_retry').catch(() => {}).finally(choice.refresh); };
  const retryGpu = () => {
    setGpuRetried(true);
    void invoke('openvino_retry').catch(() => {}).finally(choice.refresh);
  };

  const sizeOf = (bytes: number | null | undefined) => formatModelSize(bytes);
  const withSize = (label: string, bytes: number | null | undefined) => (sizeOf(bytes) ? `${label} · ${sizeOf(bytes)}` : label);
  const line = (...parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(' · ');

  // --- The Whisper row ---
  let afterRow: ReactNode;
  if (gpu && fellBack && copyInstalled) {
    // N6: the copy runs; nothing to download.
    afterRow = (
      <PairRow
        name={turboName}
        use="After meetings"
        device={null}
        line={line('Best accuracy', sizeOf(copySize), languages)}
        state={{ kind: 'installed' }}
        onRemove={() => uninstallModel('whisper')}
        removeSize={sizeOf(copySize)}
      >
        <Notice actions={<button type="button" className={noticeButton} onClick={retryGpu}>Try again</button>}>
          <span title={fellBack}>The Intel GPU version didn&apos;t start, so Whisper uses this copy. Nothing to download.</span>
        </Notice>
      </PairRow>
    );
  } else if (gpu) {
    const downloading = gpu.downloading !== null;
    const progress = gpu.progress;
    const state: RowState = downloading
      ? { kind: 'downloading', percent: gpu.downloading ?? 0, done: progress?.done, total: progress?.total }
      : gpuInstalled ? { kind: 'installed' } : { kind: 'missing' };
    const copyNote = (downloading || gpuInstalled) && copyInstalled && (downloading || choice.copyRetires);
    const update = runtimeUpdate(gpu);
    afterRow = (
      <PairRow
        name={gpuName}
        use="After meetings"
        device="Intel GPU"
        line={downloading && copyNote
          ? 'The Compressed copy stays until this one has transcribed a meeting.'
          : line('Best accuracy, fast on this computer', sizeOf(gpuInstalled ? (gpu.size ?? 0) + (gpu.runtime?.installedSize ?? 0) : gpu.downloadSize), languages)}
        state={state}
        download={!both ? { label: withSize('Download', gpu.downloadSize), onClick: () => void downloadGpu() } : null}
        onCancel={cancelGpu}
        onRemove={removeGpu}
        removeSize={sizeOf((gpu.size ?? 0) + (gpu.removesRuntime ? gpu.runtime?.installedSize ?? 0 : 0))}
      >
        {!downloading && gpuInstalled && copyNote && (
          <p className="mt-1 text-xs text-af-text-3">The Compressed copy stays until this one has transcribed a meeting.</p>
        )}
        {fellBack && !copyInstalled && (
          <Notice
            actions={
              <>
                <button type="button" className={noticeButton} onClick={retryGpu}>Try again</button>
                {copyDownloading ? (
                  <span className="px-1.5 tabular-nums text-af-text-3">{`Downloading · ${Math.round(copyJob.progress)}%`}</span>
                ) : (
                  <button type="button" className={noticeButton} onClick={() => downloadCopy(true)}>
                    {withSize('Download the standard version', copySize)}
                  </button>
                )}
              </>
            }
          >
            <span title={fellBack}>The Intel GPU version didn&apos;t start, and no regular copy is installed, so transcripts can&apos;t be improved after meetings.</span>
          </Notice>
        )}
        {update && !downloading && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-af-text-3">
            <span>{withSize("An update to Intel's libraries is available", update.downloadSize)}</span>
            <Button variant="secondary" size="xs" onClick={() => void downloadGpu(false)} aria-label="Update Intel's libraries">
              Update
            </Button>
          </div>
        )}
        {gpu.runtime?.afterRestart && (
          <p className="mt-1 text-xs text-af-text-3">Intel&apos;s libraries are updated. Whisper uses them after Protocol restarts.</p>
        )}
        {gpu.runtime?.removedAtRestart && !downloading && !gpuInstalled && (
          <p className="mt-1 text-xs text-af-text-3">Intel&apos;s libraries are removed when Protocol restarts.</p>
        )}
      </PairRow>
    );
  } else {
    // N7: no Intel GPU; the regular copy.
    afterRow = (
      <PairRow
        name={turboName}
        use="After meetings"
        device={null}
        line={line(speechModelDescription(copy?.description), sizeOf(copySize), languages)}
        state={copyDownloading ? { kind: 'downloading', percent: copyJob.progress } : copyInstalled ? { kind: 'installed' } : { kind: 'missing' }}
        download={!both ? { label: withSize('Download', copySize), onClick: () => downloadCopy(false) } : null}
        onCancel={cancelCopy}
        onRemove={() => uninstallModel('whisper')}
        removeSize={sizeOf(copySize)}
      >
        {copyJob.status === 'error' && copyJob.error && (
          <p role="alert" className="mt-2 text-xs text-af-danger [overflow-wrap:anywhere]">{copyJob.error}</p>
        )}
      </PairRow>
    );
  }

  const note = parakeetInstalled ? npuNote(npu) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <h4 className="text-sm font-semibold text-af-text">For this computer</h4>
          <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">
            Picked for your hardware: live text while you record, and a more accurate full transcript after each meeting.
          </p>
        </div>
        {both && (
          <Button variant="primary" size="sm" onClick={downloadBoth}>
            <Download />
            {withSize('Download both', bothBytes)}
          </Button>
        )}
      </div>
      <ul aria-label="For this computer" className="divide-y divide-af-border overflow-hidden rounded-xl border border-af-border bg-af-panel">
        <PairRow
          name={parakeetName}
          use="During meetings"
          device={liveDevice}
          line={liveState.kind === 'preparing' && note
            ? note
            : line(parakeetLine(npu, speechModelDescription(parakeet?.description || getModelDisplayInfo(pair.live.id)?.tagline)), sizeOf(parakeetSize), speechModelLanguages(parakeet?.languages))}
          state={liveState}
          download={!both ? { label: withSize('Download', parakeetSize), onClick: () => void downloadParakeet() } : null}
          onCancel={cancelParakeet}
          onRemove={removeParakeet}
          removeSize={sizeOf(parakeetSize)}
        >
          {note && liveState.kind !== 'preparing' && <p className="mt-1 text-xs text-af-text-3">{note}</p>}
          {runtimeWanted && parakeetInstalled && !both && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-af-text-3">
              {runtimeDownloading ? (
                <span>Downloading Intel&apos;s libraries…</span>
              ) : (
                <Button variant="secondary" size="xs" onClick={() => void downloadRuntime()}>
                  <Download />
                  {withSize("Download Intel's libraries", runtimeBytes)}
                </Button>
              )}
            </div>
          )}
          {npuFailed && (
            <Notice actions={<button type="button" className={noticeButton} onClick={retryNpu}>Try again</button>}>
              <span title={npu.reason ?? undefined}>The Intel NPU didn&apos;t start, so Parakeet runs on the processor.</span>
            </Notice>
          )}
          {errors.live && <p role="alert" className="mt-2 text-xs text-af-danger [overflow-wrap:anywhere]">{errors.live}</p>}
          {errors.runtime && <p role="alert" className="mt-2 text-xs text-af-danger [overflow-wrap:anywhere]">{errors.runtime}</p>}
        </PairRow>
        {afterRow}
      </ul>
      {errors.after && <p role="alert" className="px-1 text-xs text-af-danger [overflow-wrap:anywhere]">{errors.after}</p>}
      {offerBack && (
        <button type="button" onClick={offerBack.onClick} className="px-1 text-xs font-medium text-af-accent underline-offset-2 hover:underline">
          {offerBack.label}
        </button>
      )}
    </div>
  );
}
