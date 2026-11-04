'use client';

/**
 * What Settings and onboarding need to show the speech models for this
 * computer (#88, `lib/speech-choice.ts`): the model lists, whether the GPU is
 * an Intel GPU and the state of Whisper's Intel GPU version, the Intel NPU
 * (#66), and why the Intel GPU version last fell back. Kept current from the
 * native events; every command that fails reads as "nothing there" (the
 * OpenVINO and NPU commands exist on Windows only).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { CATALOG_EVENT } from '@/lib/model-catalog';
import type { CompanionStatus, OpenVinoAvailability } from '@/lib/intel-gpu';
import {
  NPU_ABSENT,
  NPU_EVENT,
  gpuFallback,
  isGpuVersion,
  recommendedPair,
  type DeviceContext,
  type Pair,
  type ParakeetListed,
  type ParakeetNpuStatus,
  type WhisperListed,
} from '@/lib/speech-choice';

const COMPANION_EVENT = 'openvino-companion-changed';

/** Events after which the lists or a status may have changed. */
const REFRESH_EVENTS = [
  CATALOG_EVENT,
  'model-download-complete',
  'model-download-error',
  'parakeet-model-download-complete',
  'parakeet-model-download-error',
  'optional-model-removed',
  'post-call-transcript-config-changed',
  // A post-meeting pass loads Whisper: the Intel GPU version ran or fell back.
  'retranscription-complete',
  'retranscription-error',
  'import-complete',
  'import-error',
];

interface StackStatus {
  whisper?: { openvino?: { device: string | null; fallbackReason: string | null } | null };
}

export interface SpeechChoice {
  loaded: boolean;
  whisper: WhisperListed[];
  parakeet: ParakeetListed[];
  availability: OpenVinoAvailability | null;
  /** `openvino_status` of the recommended Whisper model: the Intel GPU version and Intel's libraries. */
  companion: CompanionStatus | null;
  npu: ParakeetNpuStatus;
  /** Why the last load of the Intel GPU version fell back, in this run of Protocol. */
  fallbackReason: string | null;
  /** The Compressed copy goes after the Intel GPU version's first meeting (`speech_choice.rs`). */
  copyRetires: boolean;
  /** Parakeet downloads in progress: percent by model. */
  parakeetProgress: Record<string, number>;
  pair: Pair;
  devices: DeviceContext;
  refresh: () => void;
}

const quiet = <T,>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);

/** The Intel NPU's state alone (#66), for screens that need nothing else. */
export function useParakeetNpu(): ParakeetNpuStatus {
  const [npu, setNpu] = useState<ParakeetNpuStatus>(NPU_ABSENT);
  useEffect(() => {
    let alive = true;
    void quiet(invoke<ParakeetNpuStatus>('parakeet_npu_status'), NPU_ABSENT).then((status) => {
      if (alive) setNpu(status ?? NPU_ABSENT);
    });
    const stop = listen<ParakeetNpuStatus>(NPU_EVENT, (event) => setNpu(event.payload ?? NPU_ABSENT));
    return () => {
      alive = false;
      void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  return npu;
}

export function useSpeechChoice(): SpeechChoice {
  const [whisper, setWhisper] = useState<WhisperListed[]>([]);
  const [parakeet, setParakeet] = useState<ParakeetListed[]>([]);
  const [availability, setAvailability] = useState<OpenVinoAvailability | null>(null);
  const [companion, setCompanion] = useState<CompanionStatus | null>(null);
  const [npu, setNpu] = useState<ParakeetNpuStatus>(NPU_ABSENT);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [copyRetires, setCopyRetires] = useState(false);
  const [parakeetProgress, setParakeetProgress] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);
  const revision = useRef(0);
  const copyRef = useRef<string | null>(null);
  const downloadingRef = useRef(false);

  const refresh = useCallback(() => {
    const current = ++revision.current;
    void (async () => {
      const [whisperModels, parakeetModels, found, npuStatus, stack, retires] = await Promise.all([
        quiet(invoke<WhisperListed[]>('whisper_get_available_models'), []),
        quiet(invoke<ParakeetListed[]>('parakeet_get_available_models'), []),
        quiet(invoke<OpenVinoAvailability>('get_openvino_availability'), null),
        quiet(invoke<ParakeetNpuStatus>('parakeet_npu_status'), NPU_ABSENT),
        quiet(invoke<StackStatus>('get_local_stack_status'), null),
        quiet(invoke<boolean>('speech_choice_copy_retires'), false),
      ]);
      // The Intel GPU version serves the recommended regular copy; its status
      // also carries Intel's libraries, which the NPU needs too.
      const copy = recommendedPair({ whisper: whisperModels, parakeet: parakeetModels, availability: null, companion: null, npu: NPU_ABSENT }).copy;
      const status = await quiet(invoke<CompanionStatus | null>('openvino_status', { whisperModel: copy }), null);
      if (current !== revision.current) return;
      copyRef.current = copy;
      downloadingRef.current = status?.downloading != null;
      setWhisper(whisperModels ?? []);
      setParakeet(parakeetModels ?? []);
      setAvailability(found);
      setNpu(npuStatus ?? NPU_ABSENT);
      setFallbackReason(stack?.whisper?.openvino?.device ? null : stack?.whisper?.openvino?.fallbackReason ?? null);
      setCopyRetires(!!retires);
      setCompanion(status);
      setLoaded(true);
    })();
  }, []);

  // A running Intel GPU download reports twice a second: only its status is
  // asked again then, and everything once it ends (the model list changes).
  const refreshCompanion = useCallback(() => {
    const copy = copyRef.current;
    if (!copy) return refresh();
    void quiet(invoke<CompanionStatus | null>('openvino_status', { whisperModel: copy }), null).then((status) => {
      const ended = downloadingRef.current && status?.downloading == null;
      downloadingRef.current = status?.downloading != null;
      if (ended) refresh();
      else setCompanion(status);
    });
  }, [refresh]);

  useEffect(() => {
    refresh();
    const stops = [
      ...REFRESH_EVENTS.map((name) => listen(name, refresh)),
      listen(COMPANION_EVENT, refreshCompanion),
      listen<ParakeetNpuStatus>(NPU_EVENT, (event) => setNpu(event.payload ?? NPU_ABSENT)),
      listen<{ modelName: string; progress: number; status?: string }>('parakeet-model-download-progress', (event) => {
        const { modelName, progress, status } = event.payload;
        setParakeetProgress((previous) => {
          const next = { ...previous };
          if (status === 'cancelled' || status === 'completed' || progress >= 100) delete next[modelName];
          else next[modelName] = progress;
          return next;
        });
      }),
      listen<{ modelName: string }>('parakeet-model-download-complete', (event) => {
        setParakeetProgress(({ [event.payload.modelName]: _done, ...rest }) => rest);
      }),
      listen<{ modelName: string }>('parakeet-model-download-error', (event) => {
        setParakeetProgress(({ [event.payload.modelName]: _failed, ...rest }) => rest);
      }),
    ];
    return () => {
      revision.current += 1;
      for (const stop of stops) void stop.then((unlisten) => unlisten()).catch(() => {});
    };
  }, [refresh, refreshCompanion]);

  const pair = useMemo(() => recommendedPair({ whisper, parakeet, availability, companion, npu }), [whisper, parakeet, availability, companion, npu]);
  const devices = useMemo<DeviceContext>(() => ({
    npu,
    gpuVersion: whisper.find((model) => isGpuVersion(model)) ?? null,
    gpuFallback: gpuFallback(companion, fallbackReason, availability),
  }), [npu, whisper, companion, fallbackReason, availability]);

  return { loaded, whisper, parakeet, availability, companion, npu, fallbackReason, copyRetires, parakeetProgress, pair, devices, refresh };
}
