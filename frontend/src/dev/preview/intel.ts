/**
 * Intel GPU and NPU states for the browser preview (#88, ./models.ts): the
 * Intel GPU version of Whisper and Intel's libraries (`openvino_*`), #66's
 * NPU status, and the commands of `speech_choice.rs`.
 *
 * `?intel=` picks the hardware: `gpu,npu` (any value but the ones below),
 * `gpu`, `npu` or `none`.
 * `?gpu=` the Intel GPU version: `missing` (default), `installed`,
 * `fallback` (installed, the last load fell back) or `crash` (the crash
 * guard stopped it). `?npu=` #66's state (default `needs_runtime`). Without
 * `?intel` the preview answers as a build without these commands.
 */
import { emit } from '@tauri-apps/api/event';

const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
const intel = params?.get('intel') ?? null;
const hasGpu = intel !== null && intel !== 'none' && intel !== 'npu';
const hasNpu = intel !== null && intel !== 'none' && intel !== 'gpu';
const gpuState = params?.get('gpu') ?? 'missing';

export const GPU_ID = 'large-v3-turbo-openvino-int8';
const MB = 1024 * 1024;
const COMPANION_BYTES = 828 * MB;
const RUNTIME_BYTES = 254 * MB;

const state = {
  gpuInstalled: gpuState !== 'missing',
  runtimeInstalled: gpuState !== 'missing',
  downloading: null as number | null,
  stopped: gpuState === 'crash' ? 'Protocol closed unexpectedly the last time OpenVINO was compiling the model' : null as string | null,
  fallback: gpuState === 'fallback' ? 'OpenVINO could not compile the model for GPU' : null as string | null,
  npu: (params?.get('npu') ?? 'needs_runtime') as string,
  timer: null as ReturnType<typeof setInterval> | null,
  copyRetires: false,
};

export const intelPreview = intel !== null;

function npuStatus() {
  if (!hasNpu) return { present: false, state: 'absent', active: false, reason: null };
  const npu = state.npu === 'needs_runtime' && state.runtimeInstalled ? 'preparing' : state.npu;
  return { present: true, state: npu, active: npu === 'ready', reason: npu === 'failed' ? 'NPU compile failed: ZE_RESULT_ERROR_UNKNOWN' : null };
}

function companion() {
  const downloadSize = (state.gpuInstalled ? 0 : COMPANION_BYTES) + (state.runtimeInstalled ? 0 : RUNTIME_BYTES);
  const total = COMPANION_BYTES + RUNTIME_BYTES;
  return {
    id: GPU_ID,
    name: 'Large V3 Turbo for Intel GPUs',
    description: 'Runs on an Intel GPU instead of the Large V3 Turbo models',
    repo: 'OpenVINO/whisper-large-v3-turbo-int8-ov',
    companionOf: ['large-v3-turbo', 'large-v3-turbo-q5_0'],
    size: COMPANION_BYTES,
    companionInstalled: state.gpuInstalled,
    runtime: {
      name: 'OpenVINO GenAI', version: '2026.4.1.0',
      license: { name: 'Intel OpenVINO Distribution License', url: 'https://www.intel.com' },
      source: 'storage.openvinotoolkit.org', downloadSize: RUNTIME_BYTES, installedSize: 111 * MB,
      installed: state.runtimeInstalled ? '2026.4.1.0' : null, afterRestart: null, removedAtRestart: null,
    },
    installed: state.gpuInstalled && state.runtimeInstalled,
    downloadSize: downloadSize || null,
    refused: null,
    downloading: state.downloading,
    progress: state.downloading === null ? null : { done: (total * state.downloading) / 100, total },
    stopped: state.stopped,
    removesRuntime: true,
  };
}

/** The Whisper list's row for the Intel GPU version (`speech_choice::listed`). */
export function gpuVersionRow() {
  return {
    name: GPU_ID,
    display_name: 'Large V3 Turbo',
    description: 'Large V3 Turbo for OpenVINO, int8',
    accuracy: 'High',
    speed: 'Medium',
    tier: null,
    size_bytes: COMPANION_BYTES,
    path: '',
    status: state.gpuInstalled && state.runtimeInstalled ? 'Available' : 'Missing',
    recommended: false,
    languages: ['*'],
    companion_of: ['large-v3-turbo', 'large-v3-turbo-q5_0'],
  };
}

/** Streams progress like `openvino_download`, then installs both parts. */
function download(onDone: () => void): Promise<null> {
  return new Promise((resolve, reject) => {
    state.downloading = 0;
    void emit('openvino-companion-changed', null);
    state.timer = setInterval(() => {
      state.downloading = Math.min(100, (state.downloading ?? 0) + 3);
      void emit('openvino-companion-changed', null);
      if (state.downloading < 100) return;
      clearInterval(state.timer!);
      state.timer = null;
      state.downloading = null;
      state.gpuInstalled = true;
      state.runtimeInstalled = true;
      onDone();
      void emit('openvino-companion-changed', null);
      resolve(null);
    }, 300);
    cancelDownload = () => {
      clearInterval(state.timer!);
      state.timer = null;
      state.downloading = null;
      void emit('openvino-companion-changed', null);
      reject('The download was cancelled');
    };
  });
}
let cancelDownload: (() => void) | null = null;

/** `openvino_runtime_download` (#66's contract): archive bytes twice a second, then the NPU prepares. */
function downloadRuntime(): Promise<null> {
  if (cancelRuntime) return Promise.reject("Intel's libraries are already downloading");
  return new Promise((resolve, reject) => {
    let done = 0;
    const timer = setInterval(() => {
      done = Math.min(RUNTIME_BYTES, done + RUNTIME_BYTES / 12);
      void emit('openvino-runtime-progress', { done, total: RUNTIME_BYTES });
      if (done < RUNTIME_BYTES) return;
      clearInterval(timer);
      cancelRuntime = null;
      state.runtimeInstalled = true;
      void emit('parakeet-npu-status', npuStatus());
      resolve(null);
    }, 500);
    cancelRuntime = () => {
      clearInterval(timer);
      cancelRuntime = null;
      reject('The download was cancelled');
    };
  });
}
let cancelRuntime: (() => void) | null = null;

/** The Intel commands; `undefined` for any other command (or without `?intel`). */
export function handleIntelCommand(cmd: string, args: Record<string, any>, choose: (id: string) => void): unknown {
  if (!intelPreview) return undefined;
  switch (cmd) {
    case 'get_openvino_availability':
      return hasGpu
        ? { offer: true, gpu: 'Intel(R) Arc(TM) B390 GPU', reason: null, device: state.runtimeInstalled ? 'GPU' : null, mismatch: null }
        : { offer: false, gpu: 'NVIDIA GeForce RTX 4060 Laptop GPU', reason: 'the GPU is not an Intel GPU', device: null, mismatch: null };
    case 'openvino_status':
      return companion();
    case 'openvino_download':
      return download(() => {
        if (args.choose) {
          choose(GPU_ID);
          state.copyRetires = true;
        }
      });
    case 'openvino_cancel':
      if (args.id === 'openvino-genai') cancelRuntime?.();
      else cancelDownload?.();
      return null;
    case 'openvino_retry':
      state.stopped = null;
      state.fallback = null;
      return null;
    case 'speech_choice_remove_gpu_version':
      state.gpuInstalled = false;
      state.runtimeInstalled = false;
      void emit('openvino-companion-changed', null);
      return null;
    case 'speech_choice_copy_retires':
      return state.copyRetires;
    case 'parakeet_npu_status':
      return npuStatus();
    case 'parakeet_npu_retry':
      state.npu = 'preparing';
      void emit('parakeet-npu-status', npuStatus());
      return npuStatus();
    case 'openvino_runtime_download':
      return downloadRuntime();
    default:
      return undefined;
  }
}

/** `get_local_stack_status`'s Whisper part while the Intel GPU version fell back. */
export function openvinoStack() {
  if (!intelPreview) return undefined;
  return state.fallback ? { device: null, fallbackReason: state.fallback } : null;
}
