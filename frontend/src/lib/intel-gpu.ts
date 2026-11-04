/**
 * Whisper's Intel GPU version (#79) as native code reports it: whether this
 * computer's GPU is an Intel GPU, and the state of the companion model and
 * Intel's libraries that run it. Settings shows them in the For this
 * computer card (#88, `components/settings/ForThisComputer.tsx`).
 */

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
  /** Needed by no companion but loaded by this run: the next start removes it, a download before then reuses it. */
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

/** A newer runtime the model list pins, while the installed one runs. */
export function runtimeUpdate(companion: CompanionStatus): RuntimeStatus | null {
  const runtime = companion.runtime;
  if (!companion.installed || !runtime?.installed || runtime.installed === runtime.version || runtime.afterRestart) return null;
  return runtime;
}
