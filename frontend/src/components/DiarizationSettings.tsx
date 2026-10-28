"use client"

import { Spinner } from '@/components/ui/spinner';
import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen, UnlistenFn } from "@tauri-apps/api/event"
import { toast } from "sonner"
import {
  Users,
  AlertTriangle,
  ChevronDown,
  FolderOpen,
  Download,
  SlidersHorizontal,
} from "lucide-react"
import { Button } from "./ui/button"
import { ConfirmDialog } from "./ui/confirm-dialog"
import { RowNote, SettingRow, SettingsGroup } from "./settings/SettingsGroup"
import { cn } from "@/lib/utils"
import { formatModelSize } from "@/lib/model-catalog"
import { OPTIONAL_MODEL_PREFERENCES_CHANGED } from '@/lib/optional-model-activation';
import { useOptionalModelDownloads } from '@/contexts/OptionalModelDownloadsContext';

interface DownloadProgress {
  file: string;
  file_index: number;
  file_count: number;
  downloaded: number;
  total: number;
  percent: number;
  status: 'downloading' | 'verifying' | 'skipped' | 'done' | 'error' | string;
  message?: string;
}

interface DiarizationEngineStatus {
  active_engine: string;
  pyannote_available: boolean;
  nemotron_available: boolean;
  current_available: boolean;
  model_dir: string;
  nemotron_max_speakers: number;
  nemotron_threshold: number;
  pyannote_threshold: number;
  nemotron_download_size: number;
  pyannote_download_size: number;
}

function formatMB(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const CC_BY_4_0 = 'https://creativecommons.org/licenses/by/4.0/';

/** A credits link, opened in the system browser like the About links. */
function CreditLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => invoke('open_external_url', { url: href }).catch((e) => console.error('Failed to open URL:', e))}
      className="underline underline-offset-2 hover:text-af-text-2 cursor-pointer transition-colors"
    >
      {children}
    </button>
  );
}

/**
 * Settings › Transcription › Speakers: which engine identifies speakers
 * (bundled Pyannote, or NVIDIA Nemotron-3 downloaded on demand), its status
 * and download, Nemotron's threshold, and the model files and credits.
 */
export function DiarizationSettings() {
  const [status, setStatus] = useState<DiarizationEngineStatus | null>(null);
  const [isPyannoteDownloading, setIsDownloading] = useState(false);
  const { jobs, startDownload, uninstallModel } = useOptionalModelDownloads();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const nemotronJob = jobs.nemotron;
  const isNemotronDownloading = nemotronJob.status === 'downloading' || nemotronJob.status === 'activating';
  const isDownloading = isPyannoteDownloading || isNemotronDownloading || nemotronJob.status === 'uninstalling';
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const statusRevision = useRef(0);

  const refreshStatus = useCallback(() => {
    const revision = ++statusRevision.current;
    invoke<DiarizationEngineStatus>('diarization_get_status')
      .then(value => { if (revision === statusRevision.current) setStatus(value); })
      .catch((e) => {
        console.error('Failed to get diarization status:', e);
      });
  }, []);

  useEffect(() => {
    if (nemotronJob.status === 'ready' || nemotronJob.status === 'idle' || nemotronJob.status === 'activation-error') refreshStatus();
  }, [nemotronJob.status, refreshStatus]);

  useEffect(() => {
    refreshStatus();
    window.addEventListener(OPTIONAL_MODEL_PREFERENCES_CHANGED, refreshStatus);
    return () => window.removeEventListener(OPTIONAL_MODEL_PREFERENCES_CHANGED, refreshStatus);
  }, [refreshStatus]);

  useEffect(() => {
    let disposed = false;
    let stop: UnlistenFn | undefined;
    void listen('diarization-engine-changed', refreshStatus).then(unlisten => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(error => console.error('Could not listen for engine changes:', error));
    return () => { disposed = true; stop?.(); };
  }, [refreshStatus]);

  // Clean up download progress listener on unmount
  useEffect(() => {
    return () => {
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  const handleSelectEngine = async (engine: 'pyannote' | 'nemotron') => {
    if (isSwitching || status?.active_engine === engine) return;
    setIsSwitching(true);
    try {
      await invoke('set_diarization_engine', { engine });
      window.dispatchEvent(new Event(OPTIONAL_MODEL_PREFERENCES_CHANGED));
      if (engine === 'nemotron' && status?.nemotron_available === false) {
        toast.info('NVIDIA Nemotron is chosen', { description: 'Download it to identify speakers with it.' });
      } else {
        toast.success(`Speakers are now identified with ${engine === 'nemotron' ? 'NVIDIA Nemotron' : 'Pyannote'}`);
      }
      refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error('Failed to switch engine', { description: msg });
    } finally {
      setIsSwitching(false);
    }
  };

  const handleUpdateConfig = async (updates: {
    nemotronMaxSpeakers?: number;
    nemotronThreshold?: number;
    pyannoteThreshold?: number;
  }) => {
    if (!status) return;
    try {
      await invoke('set_diarization_config', {
        engine: status.active_engine,
        nemotronMaxSpeakers: updates.nemotronMaxSpeakers ?? status.nemotron_max_speakers,
        nemotronThreshold: updates.nemotronThreshold ?? status.nemotron_threshold,
        pyannoteThreshold: updates.pyannoteThreshold ?? status.pyannote_threshold,
      });
      refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error('Failed to update configuration', { description: msg });
    }
  };

  const handleDownload = useCallback(async (targetEngine?: string) => {
    if (isDownloading) return;
    const eng = targetEngine || status?.active_engine || 'pyannote';
    // Settings and onboarding share the same app-owned Nemotron job. Leaving
    // this page must not discard progress or create a second transfer owner.
    if (eng === 'nemotron') {
      startDownload('nemotron');
      return;
    }
    setIsDownloading(true);
    setProgress(null);
    let downloaded = false;

    try {
      unlistenRef.current = await listen<DownloadProgress>(
        'diarization-download-progress',
        (event) => setProgress(event.payload)
      );

      await invoke('download_diarization_models', { engine: eng });
      downloaded = true;
      toast.success(
        eng === 'nemotron' ? 'Nemotron-3 installed and enabled' : 'Speaker models installed',
        {
          description: 'You can now use Speakers on any meeting with a recording.',
        }
      );
      refreshStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      downloaded ||= msg.startsWith('Model downloaded, but could not enable it:');
      toast.error(downloaded ? 'Model downloaded, but could not enable it' : 'Model download failed', { description: msg });
      refreshStatus();
    } finally {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      setIsDownloading(false);
      setProgress(null);
    }
  }, [isDownloading, status, refreshStatus, startDownload]);

  const handleOpenFolder = async () => {
    try {
      await invoke('open_diarization_model_directory');
    } catch (e) {
      toast.error('Could not open folder', { description: String(e) });
    }
  };

  const activeEngine = status?.active_engine ?? 'pyannote';
  const isPyannote = activeEngine === 'pyannote';
  const isNemotron = activeEngine === 'nemotron';

  const pyannoteBytes = status?.pyannote_download_size ?? 0;
  const nemotronBytes = status?.nemotron_download_size ?? 0;
  const nemotronInstalled = status?.nemotron_available === true;
  const threshold = status?.nemotron_threshold ?? 0.50;

  return (
    <SettingsGroup title="Speakers">
      <SettingRow
        icon={Users}
        title="Speaker identification"
        description={
          <>
            After each recording, Protocol works out who said what. Your microphone is always labeled You; other
            voices become Speaker 1, 2, 3… until you name them. To redo one meeting, use Identify speakers again in
            its ··· menu. Everything runs on this computer.
          </>
        }
      >
        <div role="radiogroup" aria-label="Speaker identification engine" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
          <EngineOption
            value="pyannote"
            checked={isPyannote}
            disabled={isSwitching || isDownloading}
            onSelect={() => handleSelectEngine('pyannote')}
            title="Pyannote"
            subtitle="Built in"
            description="Works well for most meetings. Nothing to download."
            status={
              status === null ? null : status.pyannote_available ? (
                <StatusDot tone="success">Ready</StatusDot>
              ) : (
                <StatusDot tone="warning">Files missing</StatusDot>
              )
            }
          >
            {status?.pyannote_available === false && !isDownloading && (
              <div className="space-y-2.5">
                <p className="text-xs leading-relaxed text-af-text-2">
                  The bundled speaker models couldn&apos;t be found. You can re-download them
                  {pyannoteBytes > 0 && <> (~{formatMB(pyannoteBytes)})</>} from their public sources on
                  Hugging Face, each at a fixed commit — files are verified with SHA-256.
                </p>
                <Button size="sm" variant="secondary" onClick={() => handleDownload('pyannote')}>
                  <Download />
                  Re-download models
                </Button>
              </div>
            )}
            {isPyannoteDownloading && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-medium text-af-text">
                  <Spinner className="h-3.5 w-3.5" />
                  {progress?.status === 'verifying'
                    ? `Verifying ${progress.file}…`
                    : progress?.file
                      ? `Downloading ${progress.file} (${progress.file_index}/${progress.file_count})`
                      : 'Starting download…'}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-af-hover">
                  <div
                    className="h-full rounded-full bg-af-accent transition-[width] duration-150"
                    style={{ width: `${Math.max(2, progress?.percent ?? 0)}%` }}
                  />
                </div>
                <div className="flex justify-between text-[11px] tabular-nums text-af-text-3">
                  <span>{progress && progress.total > 0 ? `${formatMB(progress.downloaded)} / ${formatMB(progress.total)}` : ''}</span>
                  <span>{(progress?.percent ?? 0).toFixed(0)}%</span>
                </div>
              </div>
            )}
          </EngineOption>

          <EngineOption
            value="nemotron"
            checked={isNemotron}
            disabled={isSwitching || isDownloading}
            onSelect={() => handleSelectEngine('nemotron')}
            title="NVIDIA Nemotron"
            subtitle={nemotronInstalled ? 'Installed' : nemotronBytes > 0 ? `${formatModelSize(nemotronBytes)} download` : 'Download needed'}
            description="Better when people talk over each other, and labels up to 8 speakers live during the call. Uses the GPU on Windows when it can."
            status={
              status === null || isNemotronDownloading ? null : nemotronJob.status === 'uninstalling' ? (
                <span role="status" className="inline-flex items-center gap-1.5 text-xs text-af-text-2">
                  <Spinner className="h-3 w-3" /> Removing…
                </span>
              ) : nemotronInstalled ? (
                <StatusDot tone="success">Ready</StatusDot>
              ) : (
                <StatusDot tone={isNemotron ? 'warning' : 'muted'}>Not installed</StatusDot>
              )
            }
            actions={
              status === null || isNemotronDownloading || nemotronJob.status === 'uninstalling' ? null : nemotronInstalled ? (
                <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(true)} aria-label="Remove NVIDIA Nemotron">
                  Remove
                </Button>
              ) : (
                <Button size="xs" variant={isNemotron ? 'primary' : 'secondary'} onClick={() => handleDownload('nemotron')} disabled={isDownloading}>
                  <Download />
                  Download
                </Button>
              )
            }
          >
            {isNemotronDownloading && (
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-af-text">
                  <span>{nemotronJob.status === 'activating' ? 'Switching to Nemotron…' : nemotronJob.detail ?? 'Downloading…'}</span>
                  <span className="tabular-nums">{Math.round(nemotronJob.progress)}%</span>
                </div>
                {nemotronJob.file && <p className="mt-1 break-all text-[11px] text-af-text-3">{nemotronJob.file}</p>}
                {nemotronJob.totalBytes !== undefined && nemotronJob.totalBytes > 0 && nemotronJob.downloadedBytes !== undefined && (
                  <p className="mt-1 text-[11px] text-af-text-3">
                    Current file: {(nemotronJob.downloadedBytes / 1024 / 1024).toFixed(1)} / {(nemotronJob.totalBytes / 1024 / 1024).toFixed(1)} MiB
                  </p>
                )}
                <div role="progressbar" aria-label="Nemotron download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={nemotronJob.progress} className="mt-2 h-1.5 overflow-hidden rounded-full bg-af-hover">
                  <div className="h-full rounded-full bg-af-accent transition-[width] duration-150" style={{ width: `${nemotronJob.progress}%` }} />
                </div>
              </div>
            )}
            {isNemotron && status?.nemotron_available === false && !isNemotronDownloading && (
              <RowNote tone="warning" icon={AlertTriangle}>
                Nemotron is chosen but not downloaded, so speakers can&apos;t be identified yet. Download it, or choose Pyannote.
              </RowNote>
            )}
            {nemotronJob.error && <RowNote tone="danger">{nemotronJob.error}</RowNote>}
          </EngineOption>
        </div>
      </SettingRow>

      {isNemotron && (
        <SettingRow
          icon={SlidersHorizontal}
          title="Speech threshold"
          description="How sure Nemotron must be that someone is speaking. Raise it if background noise turns into a speaker; lower it if quiet voices are missed. The default is 0.50."
          control={
            <span className="rounded-md bg-af-active px-2 py-0.5 font-mono text-xs font-medium tabular-nums text-af-text">
              {threshold.toFixed(2)}
            </span>
          }
        >
          <input
            type="range"
            min={0.10}
            max={0.90}
            step={0.05}
            value={threshold}
            aria-label="Speech threshold"
            onChange={(e) => handleUpdateConfig({ nemotronThreshold: parseFloat(e.target.value) })}
            className="af-volume w-full max-w-md"
            style={{ '--fill': `${((threshold - 0.10) / 0.80) * 100}%` } as React.CSSProperties}
          />
        </SettingRow>
      )}

      {/* Rendered while closed, so the credits stay in the page for screen readers and tests. */}
      <details className="group px-5 py-3.5">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[13px] font-medium text-af-text-2 transition-colors hover:text-af-text [&::-webkit-details-marker]:hidden">
          Model files and credits
          <ChevronDown className="h-4 w-4 text-af-text-4 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-3 space-y-3">
          {status?.model_dir && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-af-text-2">Speaker model folder</span>
                <Button size="xs" variant="ghost" onClick={handleOpenFolder}>
                  <FolderOpen />
                  Open folder
                </Button>
              </div>
              <p className="break-all rounded-lg border border-af-border bg-af-panel px-3 py-2 font-mono text-xs text-af-text-2">
                {status.model_dir}
              </p>
              <p className="text-xs leading-relaxed text-af-text-3">
                {isPyannote ? (
                  <>
                    Drop your own <code>segmentation-3.0.onnx</code>,{' '}
                    <code>voxceleb_resnet34_LM.onnx</code> and <code>xvec_transform.npz</code> here to
                    override the bundled models.
                  </>
                ) : (
                  <>
                    Drop your own <code>nemotron3_diar_v3.onnx</code> and <code>nemo128.onnx</code> here to
                    override the downloaded models.
                  </>
                )}
              </p>
            </div>
          )}
          <p className="text-xs leading-relaxed text-af-text-4">
            Models:{' '}
            <CreditLink href="https://huggingface.co/pyannote/segmentation-3.0">pyannote segmentation-3.0</CreditLink>{' '}
            by CNRS (<CreditLink href="https://huggingface.co/pyannote/segmentation-3.0/blob/main/LICENSE">MIT</CreditLink>) ·{' '}
            <CreditLink href="https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM">WeSpeaker ResNet34-LM</CreditLink>{' '}
            by the WeSpeaker project (<CreditLink href={CC_BY_4_0}>CC BY 4.0</CreditLink>) · VBx x-vector transform by
            BUT Speech@FIT, from{' '}
            <CreditLink href="https://huggingface.co/pyannote-community/speaker-diarization-community-1">pyannote community-1</CreditLink>{' '}
            (<CreditLink href={CC_BY_4_0}>CC BY 4.0</CreditLink>). ONNX exports: segmentation by{' '}
            <CreditLink href="https://huggingface.co/onnx-community/pyannote-segmentation-3.0">onnx-community</CreditLink>,
            embeddings by the WeSpeaker project. Notices ship with the app in{' '}
            <code>resources/diarization/THIRD_PARTY_MODELS.txt</code>.
          </p>
          <p className="text-xs leading-relaxed text-af-text-4">
            NVIDIA Nemotron-3 Diarization (Sortformer v3) and the NeMo 128 mel-spectrogram model are credited to NVIDIA
            Corporation; their license downloads with them.
          </p>
        </div>
      </details>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove NVIDIA Nemotron?"
        description={`${nemotronBytes > 0 ? `This frees about ${formatModelSize(nemotronBytes)}. ` : ''}Pyannote identifies speakers from then on. You can download Nemotron again at any time.`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => uninstallModel('nemotron')}
      />
    </SettingsGroup>
  );
}

function StatusDot({ tone, children }: { tone: 'success' | 'warning' | 'muted'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium',
        tone === 'success' && 'text-af-success',
        tone === 'warning' && 'text-af-warning',
        tone === 'muted' && 'text-af-text-3',
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/**
 * One engine to choose. The radio and its text form the label; status and
 * actions sit beside it, outside the label, so no button is nested in another.
 */
function EngineOption({
  value,
  checked,
  disabled,
  onSelect,
  title,
  subtitle,
  description,
  status,
  actions,
  children,
}: {
  value: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
  description: string;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const id = `diarization-engine-${value}`;
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-xl border p-3.5 transition-colors',
        checked ? 'border-af-accent bg-af-accent/[0.07] ring-1 ring-af-accent/40' : 'border-af-border bg-af-panel hover:border-af-border-strong',
      )}
    >
      <label htmlFor={id} className={cn('flex items-start gap-3', disabled ? 'cursor-default' : 'cursor-pointer')}>
        <input
          id={id}
          type="radio"
          name="diarization-engine"
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={onSelect}
          className="mt-0.5 h-4 w-4 shrink-0 accent-af-accent"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-af-text">{title}</span>
            <span className="text-[11px] text-af-text-4">{subtitle}</span>
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-af-text-3">{description}</span>
        </span>
      </label>
      {(status || actions) && (
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-2 pl-7">
          {status ?? <span />}
          {actions}
        </div>
      )}
      {children && <div className="space-y-2 pl-7 empty:hidden">{children}</div>}
    </div>
  );
}
