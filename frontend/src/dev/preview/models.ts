/**
 * Speech models for the browser preview (see ./index.ts): the catalog's Whisper
 * and Parakeet entries with the sizes Hugging Face lists, which of them are
 * installed, the live and post-call choices, the vocabulary, and downloads
 * that report progress like the native ones.
 *
 * `?models=fresh` starts as a new install without Whisper (Parakeet only,
 * post-call following the live model), `?models=none` without any speech
 * model (recording opens the model setup dialog); the default is the state
 * onboarding's recommended setup leaves: Parakeet live, Whisper Large V3
 * Turbo after calls.
 */
import { emit } from '@tauri-apps/api/event';

type Status = 'Available' | 'Missing' | { Downloading: number };

interface WhisperEntry {
  name: string;
  display_name: string;
  description: string;
  accuracy: 'High' | 'Good' | 'Decent';
  speed: 'Slow' | 'Medium' | 'Fast' | 'Very Fast';
  tier: 'basic' | null;
  size_bytes: number;
  recommended?: boolean;
}

// model-catalog/catalog.json, in its order.
const WHISPER: WhisperEntry[] = [
  { name: 'small', display_name: 'Small', description: 'Better accuracy, moderate speed', accuracy: 'Good', speed: 'Medium', tier: 'basic', size_bytes: 487_601_967 },
  { name: 'medium-q5_0', display_name: 'Medium Compressed', description: 'Professional quality at a third of the size', accuracy: 'High', speed: 'Medium', tier: 'basic', size_bytes: 539_212_467 },
  { name: 'large-v3-q5_0', display_name: 'Large V3 Compressed', description: 'Large V3 at a third of the size, high accuracy', accuracy: 'High', speed: 'Slow', tier: 'basic', size_bytes: 1_081_140_203 },
  { name: 'large-v3-turbo', display_name: 'Large V3 Turbo', description: 'Best accuracy with improved speed', accuracy: 'High', speed: 'Medium', tier: 'basic', size_bytes: 1_624_555_275 },
  { name: 'large-v3', display_name: 'Large V3', description: 'Most accurate, latest large model', accuracy: 'High', speed: 'Slow', tier: 'basic', size_bytes: 3_095_033_483 },
  { name: 'tiny', display_name: 'Tiny', description: 'Fastest processing, good for real-time use', accuracy: 'Decent', speed: 'Very Fast', tier: null, size_bytes: 77_691_713 },
  { name: 'base', display_name: 'Base', description: 'Good balance of speed and accuracy', accuracy: 'Good', speed: 'Fast', tier: null, size_bytes: 147_951_465 },
  { name: 'medium', display_name: 'Medium', description: 'High accuracy for professional use', accuracy: 'High', speed: 'Slow', tier: null, size_bytes: 1_533_763_059 },
  { name: 'tiny-q5_1', display_name: 'Tiny Compressed', description: 'Tiny at under half the size, faster processing', accuracy: 'Decent', speed: 'Very Fast', tier: null, size_bytes: 32_152_673 },
  { name: 'base-q5_1', display_name: 'Base Compressed', description: 'Base at under half the size, good balance of speed and accuracy', accuracy: 'Good', speed: 'Fast', tier: null, size_bytes: 59_707_625 },
  { name: 'small-q5_1', display_name: 'Small Compressed', description: 'Small at under half the size, faster', accuracy: 'Good', speed: 'Fast', tier: null, size_bytes: 190_085_487 },
  { name: 'large-v3-turbo-q5_0', display_name: 'Large V3 Turbo Compressed', description: 'Large V3 Turbo at a third of the size, best balance', accuracy: 'High', speed: 'Medium', tier: 'basic', size_bytes: 574_041_195, recommended: true },
];

const PARAKEET = {
  name: 'parakeet-tdt-0.6b-v3-int8',
  display_name: 'Lightning',
  description: 'Real time, best for speed with great accuracy',
  accuracy: 'High',
  speed: 'Ultra Fast (v3)',
  quantization: 'Int8',
  recommended: true,
  languages: ['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk'],
  size_bytes: 670_619_706,
};

const scenario = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('models');
const fresh = scenario === 'fresh' || scenario === 'none';

const speech = {
  whisper: new Map<string, Status>(WHISPER.map((model) => [model.name, 'Missing' as Status])),
  parakeet: (scenario === 'none' ? 'Missing' : 'Available') as Status,
  live: { provider: 'parakeet', model: PARAKEET.name },
  postCall: fresh ? { provider: 'live', model: '' } : { provider: 'whisper', model: 'large-v3-turbo-q5_0' },
  vocabulary: fresh ? '' : 'Protocol\nTauri\nKubernetes\nOKR',
  timers: new Map<string, ReturnType<typeof setInterval>>(),
};
if (!fresh) speech.whisper.set('large-v3-turbo-q5_0', 'Available');

const catalogStatus = () => ({
  source: 'remote',
  // Milliseconds, like crate::updater::now_ms.
  fetchedAt: Date.now() - 3_600_000,
  lastCheckedAt: Date.now() - 3_600_000,
  checking: false,
  error: null,
  hidden: [],
  updates: [],
  operations: [],
  updateFailures: [],
  checkFailures: [],
  sizesVersion: 1,
});

function whisperModels() {
  return WHISPER.map((model) => ({
    ...model,
    path: `C:/Users/preview/AppData/Local/vmedvedevpro/Protocol/data/models/ggml-${model.name}.bin`,
    status: speech.whisper.get(model.name) ?? 'Missing',
    recommended: model.recommended ?? false,
    languages: ['*'],
  }));
}

/** Streams progress events like the native download, then completes it. */
function download(kind: 'whisper' | 'parakeet', name: string, postCallManaged = false): Promise<null> {
  const progressEvent = kind === 'whisper' ? 'model-download-progress' : 'parakeet-model-download-progress';
  const completeEvent = kind === 'whisper' ? 'model-download-complete' : 'parakeet-model-download-complete';
  return new Promise((resolve) => {
    let progress = 0;
    const set = (status: Status) => (kind === 'whisper' ? speech.whisper.set(name, status) : (speech.parakeet = status));
    set({ Downloading: 0 });
    const timer = setInterval(() => {
      progress = Math.min(100, progress + 4);
      set(progress < 100 ? { Downloading: progress } : 'Available');
      void emit(progressEvent, { modelName: name, progress });
      if (progress < 100) return;
      clearInterval(timer);
      speech.timers.delete(name);
      void emit(completeEvent, { modelName: name, postCallManaged });
      resolve(null);
    }, 250);
    speech.timers.set(name, timer);
  });
}

function cancel(kind: 'whisper' | 'parakeet', name: string) {
  clearInterval(speech.timers.get(name));
  speech.timers.delete(name);
  if (kind === 'whisper') speech.whisper.set(name, 'Missing');
  else speech.parakeet = 'Missing';
  if (kind === 'parakeet') void emit('parakeet-model-download-progress', { modelName: name, progress: 0, status: 'cancelled' });
  return true;
}

/** The speech-model commands; `undefined` for any other command. */
export function handleSpeechCommand(cmd: string, args: Record<string, any>): unknown {
  switch (cmd) {
    case 'whisper_init':
    case 'parakeet_init':
    case 'model_catalog_request_sizes':
      return null;
    case 'model_catalog_get_status':
    case 'model_catalog_check_now':
      return catalogStatus();
    case 'model_catalog_model_size':
      return args.engine === 'parakeet' ? PARAKEET.size_bytes : WHISPER.find((model) => model.name === args.id)?.size_bytes ?? null;
    case 'whisper_get_available_models':
      return whisperModels();
    case 'whisper_has_available_models':
      return [...speech.whisper.values()].includes('Available');
    case 'parakeet_get_available_models':
      return [{ ...PARAKEET, path: '', status: speech.parakeet }];
    case 'parakeet_has_available_models':
      return speech.parakeet === 'Available';
    case 'whisper_download_model': {
      const pending = download('whisper', args.modelName, !!args.enablePostCall);
      if (!args.enablePostCall) return null;
      // Optional setup: native code saves the post-call default once the file matched.
      return pending.then(() => {
        speech.postCall = { provider: 'whisper', model: args.modelName };
        return null;
      });
    }
    case 'parakeet_download_model':
      void download('parakeet', args.modelName);
      return null;
    case 'whisper_cancel_download':
      return cancel('whisper', args.modelName);
    case 'parakeet_cancel_download':
      return cancel('parakeet', args.modelName);
    case 'whisper_delete_corrupted_model':
      speech.whisper.set(args.modelName, 'Missing');
      return null;
    case 'parakeet_delete_corrupted_model':
      speech.parakeet = 'Missing';
      return null;
    case 'uninstall_optional_model':
      if (args.model === 'whisper') {
        speech.whisper.set('large-v3-turbo-q5_0', 'Missing');
        if (speech.postCall.model === 'large-v3-turbo-q5_0') speech.postCall = { provider: 'live', model: '' };
      }
      return null;
    case 'api_get_transcript_config':
      return { ...speech.live, apiKey: null };
    case 'api_save_transcript_config':
      speech.live = { provider: args.provider, model: args.model };
      return { status: 'success' };
    case 'api_get_post_call_transcript_config':
      return { ...speech.postCall };
    case 'api_save_post_call_transcript_config':
      speech.postCall = { provider: args.provider, model: args.provider === 'live' ? '' : args.model };
      return null;
    case 'api_get_vocabulary':
      return { global: speech.vocabulary, meeting: '' };
    case 'api_save_global_vocabulary': {
      const lines = String(args.vocabulary ?? '').split(/[\n,;]+/).map((line) => line.trim()).filter(Boolean);
      speech.vocabulary = [...new Set(lines)].join('\n');
      return speech.vocabulary;
    }
    case 'get_local_stack_status':
      return {
        recording: false,
        sttBackend: 'vulkan',
        vulkan: true,
        whisper: { loaded: false, model: null },
        parakeet: { loaded: true, model: PARAKEET.name, backend: 'CPU' },
        sttIdleUnloadSecs: 300,
        llmIdleUnloadSecs: 120,
        sttLastUnloadSecs: Math.floor(Date.now() / 1000) - 2_400,
        llmLastUnloadSecs: Math.floor(Date.now() / 1000) - 600,
        modelsDirBytes: 1_890_000_000,
        dataDirBytes: 46_000_000,
        modelsDir: 'C:/Users/preview/AppData/Local/vmedvedevpro/Protocol/data/models',
        vramHintMb: 0,
      };
    default:
      return undefined;
  }
}
