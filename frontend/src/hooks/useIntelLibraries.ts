'use client';

/**
 * Intel's libraries downloaded alone, for an Intel NPU without the Intel GPU
 * version of Whisper (#66's `openvino_runtime_download`, #88). The card, the
 * update offer and onboarding start it from different screens, so the job
 * lives here, once per WebView: every `useIntelLibraries` sees the same
 * progress, and a failure started in onboarding still shows in Settings.
 * Native code owns the download itself; it goes on if the screen closes.
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { NPU_EVENT, type ParakeetNpuStatus } from '@/lib/speech-choice';

/** The runtime's id for `openvino_cancel` (model_catalog/runtime.rs). */
const RUNTIME_ID = 'openvino-genai';
/** The native messages of a cancelled download and of a second call. */
export const CANCELLED = 'The download was cancelled';
const ALREADY_DOWNLOADING = "Intel's libraries are already downloading";

export type LibrariesJob =
  | { status: 'idle' }
  /** `total` is 0 until the first progress event (archive bytes). */
  | { status: 'downloading'; done: number; total: number }
  | { status: 'error'; error: string };

let job: LibrariesJob = { status: 'idle' };
const subscribers = new Set<() => void>();

function setJob(next: LibrariesJob) {
  job = next;
  for (const notify of subscribers) notify();
}

/**
 * Starts the download, or follows one already running. Resolves `installed`,
 * `cancelled`, or `running` (another call, perhaps before a reload, owns it:
 * its progress events and the NPU leaving `needs_runtime` end it here);
 * rejects with the native reason, which the job keeps for the card.
 */
export async function downloadIntelLibraries(): Promise<'installed' | 'cancelled' | 'running'> {
  if (job.status === 'downloading') return 'running';
  setJob({ status: 'downloading', done: 0, total: 0 });
  try {
    await invoke('openvino_runtime_download');
    setJob({ status: 'idle' });
    return 'installed';
  } catch (failure) {
    const message = String(failure);
    if (message === ALREADY_DOWNLOADING) return 'running';
    if (message === CANCELLED) {
      setJob({ status: 'idle' });
      return 'cancelled';
    }
    setJob({ status: 'error', error: message });
    throw failure;
  }
}

export function cancelIntelLibraries() {
  void invoke('openvino_cancel', { id: RUNTIME_ID }).catch(() => {});
}

/** Forgets a failure once it was shown and the person moves on. */
export function dismissIntelLibrariesError() {
  if (job.status === 'error') setJob({ status: 'idle' });
}

export function useIntelLibraries(): LibrariesJob {
  const [current, setCurrent] = useState<LibrariesJob>(job);
  useEffect(() => {
    const sync = () => setCurrent(job);
    subscribers.add(sync);
    sync();
    // The same events also report the runtime part of an Intel GPU download,
    // so they only move a job this module started or follows.
    const progress = listen<{ done: number; total: number }>('openvino-runtime-progress', (event) => {
      if (job.status === 'downloading') setJob({ status: 'downloading', done: event.payload.done, total: event.payload.total });
    });
    const npu = listen<ParakeetNpuStatus>(NPU_EVENT, (event) => {
      if (job.status === 'downloading' && event.payload && event.payload.state !== 'needs_runtime') setJob({ status: 'idle' });
    });
    return () => {
      subscribers.delete(sync);
      for (const stop of [progress, npu]) void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  return current;
}
