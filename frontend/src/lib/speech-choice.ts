/**
 * The speech models Protocol picks for this computer (#88): Parakeet for
 * live text and Whisper Large V3 Turbo after meetings, each on the best
 * device the computer has. Settings › Transcription (the "For this
 * computer" card, the update offer, the model selects) and onboarding
 * decide here, from what native code reports; nothing in this file
 * downloads or saves.
 *
 * Why the WebView decides and not Rust: every input is already a command
 * the WebView calls (`get_openvino_availability`, `openvino_status`,
 * `parakeet_npu_status`, the model lists), and the pair only steers what is
 * shown and what a click downloads. What must outlive the WebView (making
 * the Intel GPU version the after-meeting model, retiring the Compressed
 * copy) is native: `src-tauri/src/speech_choice.rs`.
 *
 * Device words in the UI are only "Intel GPU", "Intel NPU" and "the
 * processor"; every size comes from the catalog through native code.
 */
import type { RawModelInfo } from '@/hooks/useTranscriptionModels';
import type { CompanionStatus, OpenVinoAvailability } from '@/lib/intel-gpu';
import { gpuVersionLabel } from '@/lib/speech-models';

/** `parakeet_npu_status` (the #66 contract, `050r2-npu-contract.md`). */
export type NpuState = 'absent' | 'needs_runtime' | 'needs_model' | 'waiting' | 'preparing' | 'ready' | 'failed';

export interface ParakeetNpuStatus {
  /** An Intel NPU exists (known without Intel's libraries); false only for `absent`. */
  present: boolean;
  state: NpuState;
  /** The loaded Parakeet model uses the NPU right now. */
  active: boolean;
  /** `failed`: a technical reason for logs and diagnostics; never shown in the UI. */
  reason: string | null;
}

/** A failing `parakeet_npu_status` means no NPU: the NPU commands exist on Windows only. */
export const NPU_ABSENT: ParakeetNpuStatus = { present: false, state: 'absent', active: false, reason: null };

export const NPU_EVENT = 'parakeet-npu-status';

/** The Parakeet model #66 prepares for the NPU. */
export const NPU_PARAKEET = 'parakeet-tdt-0.6b-v3-int8';

/** Used when the catalog marks no recommended model (config.rs's defaults). */
export const DEFAULT_PARAKEET = 'parakeet-tdt-0.6b-v3-int8';
export const DEFAULT_WHISPER = 'large-v3-turbo-q5_0';

export type Device = 'Intel GPU' | 'Intel NPU';

/** A Whisper model list entry: the Intel GPU version lists the ggml models it serves. */
export type WhisperListed = RawModelInfo & { recommended?: boolean; companion_of?: string[] };
export type ParakeetListed = RawModelInfo & { recommended?: boolean };

export const isGpuVersion = (model: { companion_of?: string[] } | undefined | null) => !!model?.companion_of?.length;

export { gpuVersionLabel };

type Listed = { name: string; status: unknown; recommended?: boolean; companion_of?: string[] };

/**
 * A saved Intel GPU version whose entry is not installed (its files or
 * Intel's libraries gone): what a load of it runs instead, as native code
 * decides it (`speech_choice::regular_copy`): an installed regular copy it
 * serves, the recommended one first, else none (the load then fails saying
 * to download the standard version). Null when `id` is no such entry. The
 * post-meeting pass, the Import and Enhance dialogs and Settings use it.
 */
export function gpuVersionStandIn<T extends Listed>(whisper: T[], id: string): { version: T; copy: string | null } | null {
  const version = whisper.find((model) => model.name === id && isGpuVersion(model));
  if (!version || version.status === 'Available') return null;
  const installed = (version.companion_of ?? []).filter((name) =>
    whisper.some((model) => model.name === name && !isGpuVersion(model) && model.status === 'Available'));
  const copy = installed.find((name) => whisper.find((model) => model.name === name)?.recommended) ?? installed[0] ?? null;
  return { version, copy };
}

export interface PairInputs {
  whisper: WhisperListed[];
  parakeet: ParakeetListed[];
  availability: OpenVinoAvailability | null;
  /** `openvino_status` for the recommended Whisper model. */
  companion: CompanionStatus | null;
  npu: ParakeetNpuStatus;
}

export interface Pair {
  live: { id: string; device: Device | null };
  /** The Intel GPU version (`gpu`), else the recommended regular copy. */
  after: { id: string; gpu: boolean; device: Device | null };
  /** The regular copy the Intel GPU version replaces, and falls back to. */
  copy: string;
}

/** The catalog's recommended model of a list, else `fallback`. */
function recommended(models: Array<{ name: string; recommended?: boolean; companion_of?: string[] }>, fallback: string) {
  return models.find((model) => model.recommended && !isGpuVersion(model))?.name ?? fallback;
}

/** Intel's GPU version can run here: the GPU is an Intel GPU and this build can install it. */
export function gpuOffered(availability: OpenVinoAvailability | null, companion: CompanionStatus | null): boolean {
  return !!availability?.offer && !!companion && !companion.refused;
}

/** The one source of "for this computer", for Settings and onboarding. */
export function recommendedPair({ whisper, parakeet, availability, companion, npu }: PairInputs): Pair {
  const copy = recommended(whisper, DEFAULT_WHISPER);
  const live = recommended(parakeet, DEFAULT_PARAKEET);
  const gpu = gpuOffered(availability, companion);
  return {
    live: { id: live, device: npu.present && live === NPU_PARAKEET ? 'Intel NPU' : null },
    after: gpu && companion ? { id: companion.id, gpu: true, device: 'Intel GPU' } : { id: copy, gpu: false, device: null },
    copy,
  };
}

/** Why the Intel GPU version is not running although chosen and installed, or null. */
export function gpuFallback(companion: CompanionStatus | null, fallbackReason: string | null, availability: OpenVinoAvailability | null): string | null {
  if (!companion?.installed) return null;
  return companion.stopped ?? fallbackReason ?? availability?.mismatch ?? null;
}

export interface DeviceContext {
  npu: ParakeetNpuStatus;
  /** The installed Intel GPU version, if any. */
  gpuVersion: WhisperListed | null;
  /** Non-null while the Intel GPU version does not start. */
  gpuFallback: string | null;
}

/**
 * The device an installed model runs on, for its badge in the selects:
 * the Intel GPU version (and a ggml model it runs in place of, #79) on the
 * Intel GPU unless it fell back; Parakeet v3 on the Intel NPU once
 * prepared. whisper.cpp on Vulkan or the processor gets no badge: "Intel
 * GPU" names the Intel GPU version. The ggml models it runs in place of
 * (#79) have it too, the full one it is named after included: the names
 * tell them apart (`gpuVersionLabel`).
 */
export function deviceOf(engine: 'whisper' | 'parakeet', name: string, context: DeviceContext): Device | null {
  if (engine === 'parakeet') {
    return name === NPU_PARAKEET && (context.npu.state === 'ready' || context.npu.active) ? 'Intel NPU' : null;
  }
  const version = context.gpuVersion;
  if (!version || version.status !== 'Available' || context.gpuFallback) return null;
  if (name === version.name) return 'Intel GPU';
  return version.companion_of?.includes(name) ? 'Intel GPU' : null;
}

/** The NPU states in which the Labs GPU toggle for Parakeet does nothing (the NPU wins). */
export const npuOwnsParakeet = (npu: ParakeetNpuStatus) => npu.state === 'preparing' || npu.state === 'ready';

// --- The offer after an update (N2) -----------------------------------------

export const OFFER_DISMISSED_KEY = 'meetily-intel-offer-dismissed';

export interface Offer {
  devices: Device[];
  title: string;
  description: string;
  /** Switch downloads Whisper's Intel GPU version (with Intel's libraries)… */
  gpu: boolean;
  /** …or only Intel's libraries, for the NPU. */
  bytes: number | null;
}

export interface OfferInputs {
  /** At least one speech model is installed: this is an update, not a first run. */
  installedAny: boolean;
  availability: OpenVinoAvailability | null;
  companion: CompanionStatus | null;
  npu: ParakeetNpuStatus;
  /** The devices offered when the person chose Not now. */
  dismissed: Device[];
  /** Intel's libraries are downloading alone (`useIntelLibraries`): the NPU is on its way. */
  librariesDownloading?: boolean;
  /**
   * Parakeet v3, the model the NPU runs, is installed. Without it the NPU is
   * not offered: it would run nothing, and #66 keeps Intel's libraries only
   * while v3 is installed or downloading, so libraries got alone would go
   * at the next start.
   */
  npuModelInstalled: boolean;
}

/**
 * The offer at the top of Settings › Transcription: shown after an update
 * (some model is installed) when this computer has an Intel GPU without the
 * Intel GPU version of Whisper, or an Intel NPU without Intel's libraries.
 * Not now hides it until a device it did not offer then becomes one to offer.
 */
export function offerFor({ installedAny, availability, companion, npu, dismissed, librariesDownloading = false, npuModelInstalled }: OfferInputs): Offer | null {
  if (!installedAny) return null;
  const gpu = gpuOffered(availability, companion) && !companion!.installed && companion!.downloading === null;
  const npuWanted = npu.present && npu.state === 'needs_runtime' && npuModelInstalled && !librariesDownloading;
  const devices: Device[] = [...(gpu ? ['Intel GPU' as const] : []), ...(npuWanted ? ['Intel NPU' as const] : [])];
  if (devices.length === 0 || devices.every((device) => dismissed.includes(device))) return null;
  const both = gpu && npuWanted;
  const title = both ? 'Protocol can use your Intel GPU and NPU' : gpu ? 'Protocol can use your Intel GPU' : 'Protocol can use your Intel NPU';
  const description = both
    ? 'Transcripts after meetings come about 4× faster, and live text takes less power. Whisper switches to its Intel GPU version'
    : gpu
      ? 'Transcripts after meetings come about 4× faster. Whisper switches to its Intel GPU version'
      : "Live text takes less power. Protocol downloads Intel's libraries for the NPU";
  const bytes = gpu ? companion!.downloadSize : companion?.runtime?.downloadSize ?? null;
  return { devices, title, description, gpu, bytes };
}

export function readDismissed(): Device[] {
  try {
    const value = JSON.parse(localStorage.getItem(OFFER_DISMISSED_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((device): device is Device => device === 'Intel GPU' || device === 'Intel NPU') : [];
  } catch {
    return [];
  }
}

export function writeDismissed(devices: Device[]) {
  try {
    if (devices.length) localStorage.setItem(OFFER_DISMISSED_KEY, JSON.stringify(devices));
    else localStorage.removeItem(OFFER_DISMISSED_KEY);
  } catch {
    // Storage off: the offer shows again next time, which is harmless.
  }
}

// --- Copy for the card ------------------------------------------------------

/** "640 MB", from bytes; empty while unknown (formatModelSize). */
export type SizeFormat = (bytes: number | null | undefined) => string;

/** The sum of the parts' sizes, or null when one of them is unknown. */
export function sumBytes(parts: Array<number | null | undefined>): number | null {
  let total = 0;
  for (const part of parts) {
    if (!part || part <= 0) return null;
    total += part;
  }
  return parts.length ? total : null;
}

/** Parakeet's line in the card (N1, N6, N7). */
export function parakeetLine(npu: ParakeetNpuStatus, catalogDescription: string): string {
  if (npu.present && npu.state === 'failed') return 'Real time';
  if (npu.present) return 'Real time, light on power';
  return catalogDescription;
}

/**
 * What the NPU's state adds under Parakeet in the card, if anything.
 * `withWhisper`: Intel's libraries come with Whisper's Intel GPU version, so
 * the card has no download of their own to point at.
 */
export function npuNote(npu: ParakeetNpuStatus, withWhisper = false): string | null {
  switch (npu.state) {
    case 'preparing':
      return 'Getting ready for the Intel NPU, once. Live text keeps working meanwhile.';
    case 'waiting':
      return 'Gets ready for the Intel NPU once the recording or transcription has finished. Live text keeps working meanwhile.';
    case 'needs_runtime':
      return withWhisper
        ? "Runs on the Intel NPU once Whisper's Intel GPU version is downloaded: it brings Intel's libraries."
        : "Runs on the Intel NPU once Intel's libraries are downloaded.";
    default:
      return null;
  }
}
