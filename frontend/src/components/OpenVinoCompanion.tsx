'use client';

/**
 * The OpenVINO companion of the Whisper model in use (#79): a copy of the
 * model exported for OpenVINO, which runs it on an Intel GPU instead of
 * whisper.cpp on Vulkan. Shown only where OpenVINO can run (an Intel GPU, the
 * bundled runtime) and only for a model that has a companion. Nothing is
 * downloaded without a click here: the row says what the download is, how
 * big it is and why.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Cpu } from 'lucide-react';
import { toast } from 'sonner';
import { SettingRow } from './settings/SettingsGroup';
import { ModelList, ModelRow, type ModelRowStatus } from './settings/ModelRow';

/** `get_openvino_availability` (whisper_engine/commands.rs). */
export interface OpenVinoAvailability {
  available: boolean;
  /** The GPU OpenVINO would run on, as OpenVINO names it. */
  device: string | null;
  /** Why OpenVINO cannot run here, when it cannot. */
  reason: string | null;
}

/** `openvino_companion_status` (model_catalog/openvino.rs). */
export interface CompanionStatus {
  id: string;
  name: string;
  description: string;
  companionOf: string[];
  size: number | null;
  installed: boolean;
  downloading: number | null;
}

const CHANGED_EVENT = 'openvino-companion-changed';
// The native message of a cancelled download (model_catalog/openvino.rs).
const CANCELLED = 'The download was cancelled';

/** The first of `whisperModels` that has a companion, with its status. */
async function companionOf(whisperModels: string[]): Promise<CompanionStatus | null> {
  for (const whisperModel of whisperModels) {
    const status = await invoke<CompanionStatus | null>('openvino_companion_status', { whisperModel });
    if (status) return status;
  }
  return null;
}

export function rowStatus(companion: CompanionStatus, error: string | null): ModelRowStatus {
  if (companion.downloading !== null) return { Downloading: companion.downloading };
  if (companion.installed) return 'Available';
  return error ? { Error: error } : 'Missing';
}

export function OpenVinoCompanion({ whisperModels }: { whisperModels: string[] }) {
  const [availability, setAvailability] = useState<OpenVinoAvailability | null>(null);
  const [companion, setCompanion] = useState<CompanionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const models = whisperModels.join('\n');
  const revision = useRef(0);

  const refresh = useCallback(() => {
    const current = ++revision.current;
    const wanted = models ? models.split('\n') : [];
    companionOf(wanted)
      .then((status) => { if (current === revision.current) setCompanion(status); })
      .catch(() => { if (current === revision.current) setCompanion(null); });
  }, [models]);

  useEffect(() => {
    // Builds without OpenVINO (macOS, Linux) have no such command: no row.
    invoke<OpenVinoAvailability>('get_openvino_availability')
      .then(setAvailability)
      .catch(() => setAvailability(null));
  }, []);

  useEffect(() => {
    if (!availability?.available) return;
    refresh();
    const unlisten = listen(CHANGED_EVENT, refresh);
    return () => { void unlisten.then((stop) => stop()); };
  }, [availability, refresh]);

  if (!availability?.available || !companion) return null;

  const download = async () => {
    setError(null);
    try {
      await invoke('openvino_companion_download', { id: companion.id });
      toast.success(`${companion.name} is ready`, { description: 'Whisper uses it from the next transcription on.' });
    } catch (failure) {
      const message = String(failure);
      if (message !== CANCELLED) setError(message);
    }
    refresh();
  };
  const cancel = () => { void invoke('openvino_companion_cancel', { id: companion.id }).catch(() => {}); };
  const remove = async () => {
    try {
      await invoke('openvino_companion_delete', { id: companion.id });
    } catch (failure) {
      toast.error(`Could not remove ${companion.name}`, { description: String(failure) });
    }
    refresh();
  };

  const gpu = availability.device ? ` (${availability.device})` : '';
  return (
    <SettingRow
      icon={Cpu}
      title="Intel GPU"
      description={`With this download, Whisper runs on your Intel GPU${gpu} through OpenVINO instead of Vulkan. It is a separate copy of the model, made for OpenVINO.`}
    >
      <ModelList label="OpenVINO models">
        <ModelRow
          name={companion.name}
          description={companion.description}
          status={rowStatus(companion, error)}
          sizeBytes={companion.size}
          usage={companion.installed ? ['Used on the Intel GPU'] : []}
          onDownload={() => void download()}
          onCancel={cancel}
          onRemove={remove}
        />
      </ModelList>
    </SettingRow>
  );
}
