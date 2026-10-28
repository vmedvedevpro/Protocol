'use client';

/**
 * Settings › Local AI. Live snapshot of what is loaded on this machine:
 * the Parakeet and Whisper speech models, idle unload and freeing memory,
 * disk use, and the network policy.
 */

import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { AudioLines, HardDrive, MemoryStick, Shield, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingRow, SettingsGroup } from '@/components/settings/SettingsGroup';
import {
  formatWhisperBackend,
  getWhisperBackend,
  type TranscriptionAccelerationStatus,
} from '@/lib/transcription-acceleration';

type StackStatus = TranscriptionAccelerationStatus & {
  recording: boolean;
  whisper: { loaded: boolean; model: string | null };
  parakeet: { loaded: boolean; model: string | null; backend: 'CPU' | 'DirectML' };
  sttIdleUnloadSecs: number;
  llmIdleUnloadSecs: number;
  sttLastUnloadSecs?: number;
  llmLastUnloadSecs?: number;
  modelsDirBytes?: number;
  dataDirBytes?: number;
  modelsDir?: string;
  vramHintMb?: number;
  networkPolicy?: string;
  networkNote?: string;
};

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        ok
          ? 'bg-af-success/15 text-af-success'
          : 'bg-[var(--af-panel-2)] text-[var(--af-text-3)]'
      }`}
    >
      {label}
    </span>
  );
}

function formatBytes(n?: number): string {
  if (n == null || n <= 0) return '—';
  const gb = n / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = n / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}

function formatIdle(secs?: number): string {
  if (secs == null) return '—';
  if (secs < 60) return `${secs} s`;
  const minutes = Math.round(secs / 60);
  return `${minutes} min`;
}

function formatAgo(unixSecs?: number): string {
  if (!unixSecs) return 'not yet';
  const ago = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return `${Math.floor(ago / 86400)}d ago`;
}

export function LocalStackStatus() {
  const [status, setStatus] = useState<StackStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const whisperBackend = getWhisperBackend(status);
  const whisperBackendLabel = whisperBackend
    ? formatWhisperBackend(whisperBackend)
    : 'Detecting...';
  const parakeetBackend = status?.parakeet.backend ?? 'CPU';

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<StackStatus>('get_local_stack_status');
      setStatus(s);
    } catch (e) {
      console.error('get_local_stack_status failed', e);
      toast.error('Could not read local stack status');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const unloadStt = async () => {
    setBusy(true);
    try {
      await invoke('force_unload_stt_models');
      toast.success('Speech models unloaded');
      await refresh();
    } catch (e) {
      toast.error(typeof e === 'string' ? e : 'Unload failed (recording in progress?)');
    } finally {
      setBusy(false);
    }
  };

  const freeAll = async () => {
    setBusy(true);
    try {
      await invoke('force_unload_all_models');
      toast.success('Speech and summary models unloaded');
      await refresh();
    } catch (e) {
      toast.error(typeof e === 'string' ? e : 'Free-all failed (recording in progress?)');
    } finally {
      setBusy(false);
    }
  };

  const whisperAccelerated = whisperBackend != null && whisperBackend !== 'CPU';

  return (
    <div className="space-y-8">
      <p className="text-[13px] leading-relaxed text-af-text-3">
        What is loaded on this computer right now. Speech models and the local summary model never stay loaded at the
        same time, so they don&apos;t compete for memory. This page updates by itself.
      </p>

      <SettingsGroup title="Speech models">
        <SettingRow
          icon={Zap}
          title="Parakeet"
          description={status?.parakeet.model ? `Model: ${status.parakeet.model}` : 'Fast speech model, used while recording.'}
          control={
            <span className="flex flex-wrap items-center justify-end gap-1.5">
              <Pill ok={!!status?.parakeet.loaded} label={status?.parakeet.loaded ? 'Loaded' : 'Not loaded'} />
              <Pill ok={parakeetBackend === 'DirectML'} label={parakeetBackend === 'DirectML' ? 'GPU (DirectML encoder)' : 'CPU'} />
            </span>
          }
        >
          {parakeetBackend === 'DirectML' && (
            <p className="text-xs text-af-text-3">Parakeet sends supported encoder operations to DirectML. Its decoder and preprocessor use the CPU.</p>
          )}
        </SettingRow>
        <SettingRow
          icon={AudioLines}
          title="Whisper"
          description={status?.whisper.model ? `Model: ${status.whisper.model}` : 'Accurate speech model, usually used after meetings.'}
          control={
            <span className="flex flex-wrap items-center justify-end gap-1.5">
              <Pill ok={!!status?.whisper.loaded} label={status?.whisper.loaded ? 'Loaded' : 'Not loaded'} />
              <Pill ok={whisperAccelerated} label={whisperBackendLabel} />
            </span>
          }
        >
          <p className="text-xs text-af-text-3">Whisper&apos;s acceleration was chosen for this computer when Protocol was installed.</p>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Memory">
        <SettingRow
          icon={MemoryStick}
          title="Unload when idle"
          description={`Speech models unload after ${formatIdle(status?.sttIdleUnloadSecs)} without use, the summary model after ${formatIdle(status?.llmIdleUnloadSecs)}.`}
        >
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-af-text-3">
              {`Last unloaded: speech models ${formatAgo(status?.sttLastUnloadSecs)}, summary model ${formatAgo(status?.llmLastUnloadSecs)}.`}
              {status?.vramHintMb ? ` The speech models loaded now use about ${status.vramHintMb} MB.` : ''}
            </p>
            {status?.recording && <p className="text-xs text-af-warning">A recording is running, so nothing is unloaded until it ends.</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={busy || !!status?.recording} onClick={() => void unloadStt()}>
                Unload speech models
              </Button>
              <Button variant="secondary" size="sm" disabled={busy || !!status?.recording} onClick={() => void freeAll()}>
                Free all memory
              </Button>
            </div>
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Storage and privacy">
        <SettingRow
          icon={HardDrive}
          title="Disk"
          description={`Models ${formatBytes(status?.modelsDirBytes)} · App data ${formatBytes(status?.dataDirBytes)}`}
        >
          {status?.modelsDir && (
            <p className="truncate font-mono text-[11px] text-af-text-3" title={status.modelsDir}>
              {status.modelsDir}
            </p>
          )}
        </SettingRow>
        <SettingRow
          icon={Shield}
          title="Network"
          description={
            status?.networkNote ||
            'Nothing leaves this computer unless you add a cloud API key and choose that provider for summaries.'
          }
          control={<Pill ok label="Local-first · no telemetry" />}
        />
      </SettingsGroup>
    </div>
  );
}

export default LocalStackStatus;
