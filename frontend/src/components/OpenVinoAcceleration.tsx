'use client';

/**
 * Whisper on the Intel GPU (#79): the OpenVINO companion of the Whisper model
 * in use and Intel's OpenVINO GenAI runtime that runs it, installed together
 * with one click. Offered only where whisper.cpp's GPU is an Intel GPU, and
 * only for a model that has a companion. Nothing is downloaded without a
 * click here: the row says what is downloaded, from where, under which
 * licence and how big it is. A newer runtime the model list pins is offered
 * as an update; a GPU OpenVINO turns out not to run on is said, not hidden.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Cpu } from 'lucide-react';
import { toast } from 'sonner';
import { SettingRow } from './settings/SettingsGroup';
import { ModelList, ModelRow, type ModelRowStatus } from './settings/ModelRow';
import { CATALOG_EVENT, formatModelSize } from '@/lib/model-catalog';

/** `get_openvino_availability` (whisper_engine/openvino/mod.rs). */
export interface OpenVinoAvailability {
  /** Offer the download: the GPU whisper.cpp uses is an Intel GPU. */
  offer: boolean;
  /** That GPU, as Vulkan names it. */
  gpu: string | null;
  /** Why the download is not offered. */
  reason: string | null;
  /** With the runtime installed: the OpenVINO device Whisper runs on… */
  device: string | null;
  /** …or why OpenVINO cannot run Whisper here after all. */
  mismatch: string | null;
}

/** `openvino_status` (model_catalog/openvino.rs). */
export interface RuntimeStatus {
  name: string;
  /** The version a download installs. */
  version: string;
  license: { name: string; url: string };
  /** The host the archive comes from. */
  source: string;
  downloadSize: number;
  installedSize: number;
  /** The installed version that runs, if any. */
  installed: string | null;
  /** Installed while this run of Protocol uses another: used after a restart. */
  afterRestart: string | null;
  /** Needed by no companion but loaded by this run: the next start removes it; it counts as not installed. */
  removedAtRestart: string | null;
}

export interface CompanionStatus {
  id: string;
  name: string;
  description: string;
  repo: string;
  companionOf: string[];
  /** The companion's size. */
  size: number | null;
  companionInstalled: boolean;
  runtime: RuntimeStatus | null;
  /** Both are installed. */
  installed: boolean;
  /** What a click on Download fetches now. */
  downloadSize: number | null;
  /** Why this version of Protocol cannot install the runtime. */
  refused: string | null;
  downloading: number | null;
  /** A running download's bytes: what it fetches, not `size` or `downloadSize` once a part is installed during it. */
  progress: { done: number; total: number } | null;
  /** OpenVINO is off because Protocol closed unexpectedly inside it; `openvino_retry` turns it on. */
  stopped: string | null;
  /** Remove deletes the installed runtime too: no other companion keeps it. */
  removesRuntime: boolean;
}

const CHANGED_EVENT = 'openvino-companion-changed';
// The native message of a cancelled download (model_catalog/runtime.rs).
const CANCELLED = 'The download was cancelled';

/** The first of `whisperModels` that has a companion, with its status. */
async function companionOf(whisperModels: string[]): Promise<CompanionStatus | null> {
  for (const whisperModel of whisperModels) {
    const status = await invoke<CompanionStatus | null>('openvino_status', { whisperModel });
    if (status) return status;
  }
  return null;
}

/** A newer runtime the model list pins, while the installed one runs. */
export function runtimeUpdate(companion: CompanionStatus): RuntimeStatus | null {
  const runtime = companion.runtime;
  if (!companion.installed || !runtime?.installed || runtime.installed === runtime.version || runtime.afterRestart) return null;
  return runtime;
}

/**
 * The toast after a download installed everything, from the status asked
 * again then: a runtime this run has not loaded is used after a restart, as
 * the row says, and the crash guard keeps OpenVINO off until it is retried.
 */
export function installedNotice(companion: CompanionStatus): { title: string; description: string } {
  const runtime = companion.runtime;
  if (runtime?.afterRestart) {
    return { title: `${runtime.name} ${runtime.afterRestart} is installed`, description: 'Protocol uses it after a restart.' };
  }
  if (companion.stopped) {
    return { title: `${companion.name} is installed`, description: 'Whisper stays on Vulkan until you try OpenVINO again in this row.' };
  }
  return { title: `${companion.name} is ready`, description: 'Whisper uses the Intel GPU from the next transcription on.' };
}

export function rowStatus(companion: CompanionStatus, error: string | null): ModelRowStatus {
  if (companion.downloading !== null) return { Downloading: companion.downloading };
  if (companion.installed) return 'Available';
  return error ? { Error: error } : 'Missing';
}

/** What the download consists of: the runtime from Intel, the model from Hugging Face. */
function Parts({ companion }: { companion: CompanionStatus }) {
  const runtime = companion.runtime;
  const openLicense = (url: string) => {
    invoke('open_external_url', { url }).catch(() => {});
  };
  const runtimeSizes = runtime
    ? `${formatModelSize(runtime.downloadSize)} download, ${formatModelSize(runtime.installedSize)} on disk`
    : '';
  const modelSize = formatModelSize(companion.size);
  return (
    <ul className="mt-2 space-y-1 text-xs leading-relaxed text-af-text-3">
      {runtime && (
        <li>
          {`Intel's ${runtime.name} ${runtime.version} libraries, from ${runtime.source} (${runtimeSizes}), under the `}
          <button
            type="button"
            className="font-medium text-af-accent underline-offset-2 hover:underline"
            onClick={() => openLicense(runtime.license.url)}
          >
            {runtime.license.name}
          </button>
          {runtime.installed ? ` · ${runtime.installed} installed` : ''}
        </li>
      )}
      <li>{`The model, from Hugging Face (${companion.repo})${modelSize ? `, ${modelSize}` : ''}${companion.companionInstalled ? ' · installed' : ''}`}</li>
    </ul>
  );
}

export function OpenVinoAcceleration({ whisperModels }: { whisperModels: string[] }) {
  const [availability, setAvailability] = useState<OpenVinoAvailability | null>(null);
  const [companion, setCompanion] = useState<CompanionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const models = whisperModels.join('\n');
  const revision = useRef(0);
  const wanted = useCallback(() => (models ? models.split('\n') : []), [models]);

  const refresh = useCallback(() => {
    const current = ++revision.current;
    // The device is decided once the runtime is installed: ask again.
    invoke<OpenVinoAvailability>('get_openvino_availability')
      .then((found) => { if (current === revision.current) setAvailability(found); })
      .catch(() => { if (current === revision.current) setAvailability(null); });
    companionOf(wanted())
      .then((status) => { if (current === revision.current) setCompanion(status); })
      .catch(() => { if (current === revision.current) setCompanion(null); });
  }, [wanted]);

  useEffect(() => {
    refresh();
    const stops = [listen(CHANGED_EVENT, refresh), listen(CATALOG_EVENT, refresh)];
    return () => { for (const stop of stops) void stop.then((unlisten) => unlisten()); };
  }, [refresh]);

  // Builds without OpenVINO (macOS, Linux) offer nothing; a companion or
  // runtime installed before stays reachable for its removal.
  const installedAny = !!companion && (companion.companionInstalled || !!companion.runtime?.installed);
  if (!availability || !companion || (!availability.offer && !installedAny)) return null;

  const download = async () => {
    setError(null);
    try {
      await invoke('openvino_download', { id: companion.id });
      const notice = installedNotice((await companionOf(wanted()).catch(() => null)) ?? companion);
      toast.success(notice.title, { description: notice.description });
    } catch (failure) {
      const message = String(failure);
      if (message !== CANCELLED) setError(message);
    }
    refresh();
  };
  const cancel = () => { void invoke('openvino_cancel', { id: companion.id }).catch(() => {}); };
  const remove = async () => {
    try {
      await invoke('openvino_remove', { id: companion.id });
    } catch (failure) {
      toast.error(`Could not remove ${companion.name}`, { description: String(failure) });
    }
    refresh();
  };
  const retry = async () => {
    await invoke('openvino_retry').catch(() => {});
    refresh();
  };
  const textButton = 'shrink-0 rounded px-2 py-1 font-medium text-af-accent hover:bg-af-accent/10';
  // Intel's libraries without the model: a download that stopped after them.
  // Offered for removal only when no other companion keeps them.
  const runtimeOnly = !companion.installed && !!companion.runtime?.installed && companion.downloading === null
    && companion.removesRuntime;

  const gpu = availability.gpu ? ` (${availability.gpu})` : '';
  const update = runtimeUpdate(companion);
  const onDisk = (companion.size ?? 0) + (companion.runtime?.installedSize ?? 0);
  const sizeBytes = companion.installed ? onDisk : companion.downloadSize;
  const notes = (
    <>
      <Parts companion={companion} />
      {companion.stopped && (
        <div role="alert" className="mt-2 flex items-center justify-between gap-3 text-xs text-af-warning">
          <p className="[overflow-wrap:anywhere]">{companion.stopped}</p>
          <button type="button" className={textButton} onClick={() => void retry()}>Try OpenVINO again</button>
        </div>
      )}
      {runtimeOnly && (
        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-af-text-2">
          <p>{`Intel's libraries are installed without the model; Download fetches only the model.`}</p>
          <button type="button" className={textButton} onClick={() => void remove()}>Remove the libraries</button>
        </div>
      )}
      {availability.device && companion.installed && (
        // The device rule picks the GPU whisper.cpp uses, so it is the one the
        // description names; OpenVINO's own name for it (`GPU`, `GPU.1`) says nothing.
        <p className="mt-2 text-xs text-af-text-3">{`Whisper runs on ${availability.gpu ?? availability.device} with OpenVINO.`}</p>
      )}
      {availability.mismatch && (
        <p role="alert" className="mt-2 text-xs text-af-warning [overflow-wrap:anywhere]">
          {`OpenVINO cannot run Whisper here: ${availability.mismatch}`}
        </p>
      )}
      {companion.runtime?.removedAtRestart && companion.downloading === null && (
        <p className="mt-2 text-xs text-af-text-2">
          {`Intel's ${companion.runtime.name} ${companion.runtime.removedAtRestart} libraries are removed when Protocol restarts.`}
        </p>
      )}
      {companion.runtime?.afterRestart && (
        <p className="mt-2 text-xs text-af-text-2">
          {`${companion.runtime.name} ${companion.runtime.afterRestart} is installed. Protocol uses it after a restart.`}
        </p>
      )}
      {update && companion.downloading === null && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-af-border pt-3 text-xs">
          <p className="text-af-text-2">
            {`${update.name} ${update.version} is available · ${formatModelSize(update.downloadSize)} to download`}
          </p>
          <button
            type="button"
            className={textButton}
            aria-label={`Update ${update.name} to ${update.version}`}
            onClick={() => void download()}
          >
            {error ? 'Try again' : 'Update'}
          </button>
        </div>
      )}
      {update && error && <p role="alert" className="mt-1 text-xs text-af-danger [overflow-wrap:anywhere]">{error}</p>}
    </>
  );

  return (
    <SettingRow
      icon={Cpu}
      title="Intel GPU"
      description={`With this download, Whisper runs on your Intel GPU${gpu} through OpenVINO instead of Vulkan. It is Intel's OpenVINO libraries and a copy of the model made for them; one click installs both.`}
    >
      {companion.refused && !companion.installed ? (
        <p role="alert" className="text-xs text-af-text-3 [overflow-wrap:anywhere]">{companion.refused}</p>
      ) : (
        <ModelList label="OpenVINO models">
          <ModelRow
            name={companion.name}
            description={companion.description}
            status={rowStatus(companion, update ? null : error)}
            sizeBytes={sizeBytes}
            progress={companion.progress ?? null}
            usage={companion.installed && !companion.stopped ? ['Used on the Intel GPU'] : []}
            onDownload={() => void download()}
            onCancel={cancel}
            onRemove={remove}
            footer={notes}
          />
        </ModelList>
      )}
    </SettingRow>
  );
}
