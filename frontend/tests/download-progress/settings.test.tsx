import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, afterEach, expect, mock, test } from 'bun:test';

let jobs: any;
let nativeWhisperAvailable: boolean;
let nativeNemotronAvailable: boolean;
let activeEngine: string;
let pyannoteAvailable: boolean;
let postCall: { provider: string; model: string };
let openedUrls: string[];
let whisperManagerProps: any;
const startDownload = mock(() => {});
const uninstallModel = mock(() => {});
mock.module('@/contexts/OptionalModelDownloadsContext', () => ({
  OPTIONAL_WHISPER_MODEL: 'large-v3-turbo-q5_0',
  useOptionalModelDownloads: () => ({ jobs, startDownload, uninstallModel }),
}));
mock.module('@/hooks/useLabs', () => ({ useLabs: () => ({ labs: {} }) }));
mock.module('@/components/WhisperModelManager', () => ({ ModelManager: (props: any) => { whisperManagerProps = props; return null; } }));
mock.module('@/components/ParakeetModelManager', () => ({ ParakeetModelManager: () => null }));
mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args?: { url: string }) => {
  if (command === 'open_external_url') { openedUrls.push(args!.url); return; }
  if (command === 'diarization_get_status') return { active_engine: activeEngine, nemotron_available: nativeNemotronAvailable, pyannote_available: pyannoteAvailable, model_dir: 'fixture-models', nemotron_threshold: 0.5 };
  if (command === 'whisper_get_available_models') return [{ name: 'large-v3-turbo-q5_0', display_name: 'Large V3 Turbo Compressed', status: nativeWhisperAvailable ? 'Available' : 'Missing' }];
  if (command === 'parakeet_get_available_models') return [{ name: 'parakeet-tdt-0.6b-v3-int8', display_name: 'Lightning', status: 'Available' }];
  if (command === 'api_get_post_call_transcript_config') return postCall;
  if (command === 'api_get_vocabulary') return { global: '', meeting: '' };
  if (command === 'get_recording_preferences') return { real_time_transcription: false };
  throw new Error(command);
} }));

const { DiarizationSettings } = await import('../../src/components/DiarizationSettings');
const { TranscriptSettings } = await import('../../src/components/TranscriptSettings');
const { ConfirmDialog } = await import('../../src/components/ui/confirm-dialog');
let root: ReactTestRenderer;
const setLive = mock(() => {});
const setLanguage = mock(() => {});
// Settings › Transcription: the Speakers group sits inside the transcription layout.
function App() {
  return (
    <TranscriptSettings
      transcriptModelConfig={{ provider: 'parakeet', model: 'parakeet-tdt-0.6b-v3-int8' }}
      setTranscriptModelConfig={setLive}
      language={{ value: 'auto', onChange: setLanguage }}
      speakerSettings={<DiarizationSettings />}
    />
  );
}
const text = () => JSON.stringify(root.toJSON());
// The Radix Select root carries the picker's value; its options render only while open.
const picker = (name: string) => root.root.findAllByProps({ name })[0];
beforeEach(() => {
  jobs = { whisper: { status: 'idle', progress: 0 }, nemotron: { status: 'idle', progress: 0 } };
  activeEngine = 'pyannote'; nativeWhisperAvailable = false; nativeNemotronAvailable = false; pyannoteAvailable = true;
  postCall = { provider: 'live', model: '' };
  openedUrls = [];
  whisperManagerProps = undefined;
  startDownload.mockClear(); uninstallModel.mockClear(); setLive.mockClear(); setLanguage.mockClear();
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: Object.assign(new EventTarget(), { setTimeout, clearTimeout }) });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => null, removeItem: () => {} } });
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('Settings shows both background downloads before they are selected and refreshes installed/active status on completion', async () => {
  jobs.whisper = { status: 'downloading', progress: 64 };
  jobs.nemotron = { status: 'downloading', progress: 37, file: 'nemotron3_diar_v3.onnx', downloadedBytes: 1048576, totalBytes: 2097152 };
  await act(async () => { root = create(<App />); });
  expect(root.root.findByProps({ 'aria-label': 'Whisper download progress' }).props['aria-valuenow']).toBe(64);
  expect(root.root.findByProps({ 'aria-label': 'Nemotron download progress' }).props['aria-valuenow']).toBe(37);
  expect(text()).toContain('Current file: ');
  expect(text()).not.toContain('Get a cleaner transcript with Whisper');
  nativeWhisperAvailable = true; nativeNemotronAvailable = true; activeEngine = 'nemotron';
  postCall = { provider: 'whisper', model: 'large-v3-turbo-q5_0' };
  jobs.whisper = { status: 'ready', progress: 100, enabled: true };
  jobs.nemotron = { status: 'ready', progress: 100, enabled: true };
  await act(async () => {
    root.update(<App />);
    window.dispatchEvent(new Event('optional-model-preferences-changed'));
  });
  expect(picker('after-meeting-model').props.value).toBe('whisper:large-v3-turbo-q5_0');
  expect(root.root.findByProps({ id: 'diarization-engine-nemotron' }).props.checked).toBe(true);
  expect(text()).toContain('Installed');
  expect(root.root.findAllByProps({ role: 'progressbar' })).toHaveLength(0);
  expect(root.root.findByProps({ 'aria-label': 'Remove NVIDIA Nemotron' })).toBeDefined();
  expect(setLive).not.toHaveBeenCalled();
});

test('removing an optional model targets only that model', async () => {
  nativeWhisperAvailable = true; nativeNemotronAvailable = true; activeEngine = 'nemotron';
  jobs.whisper = { status: 'ready', progress: 100, enabled: true };
  jobs.nemotron = { status: 'ready', progress: 100, enabled: true };
  await act(async () => { root = create(<App />); });
  // The optional Whisper model is uninstalled natively; other Whisper models
  // are removed by the model list itself.
  expect(whisperManagerProps.removeModel('small')).toBe(false);
  expect(uninstallModel).not.toHaveBeenCalled();
  expect(whisperManagerProps.removeModel('large-v3-turbo-q5_0')).toBe(true);
  expect(uninstallModel).toHaveBeenCalledWith('whisper');
  // Nemotron's Remove asks first; confirming uninstalls Nemotron only.
  await act(async () => root.root.findByProps({ 'aria-label': 'Remove NVIDIA Nemotron' }).props.onClick());
  await act(async () => root.root.findByType(ConfirmDialog).props.onConfirm());
  expect(uninstallModel).toHaveBeenLastCalledWith('nemotron');
  expect(uninstallModel).toHaveBeenCalledTimes(2);
});

test('the pickers show what runs during and after meetings, and say when a choice cannot run', async () => {
  await act(async () => { root = create(<App />); });
  expect(picker('live-model').props.value).toBe('parakeet:parakeet-tdt-0.6b-v3-int8');
  expect(picker('after-meeting-model').props.value).toBe('live');
  expect(text()).toContain('Uses Parakeet · Lightning.');
  // Without Whisper, the after-meeting step offers the recommended download,
  // by its catalog name: the full Large V3 Turbo is another model.
  expect(text()).toContain('Get a cleaner transcript with Whisper');
  expect(text()).toContain('Whisper Large V3 Turbo Compressed is slower than Parakeet');
  await act(async () => picker('meeting-language').props.onValueChange('de'));
  expect(setLanguage).toHaveBeenCalledWith('de');

  // A saved Whisper choice whose model is gone is reported, not hidden.
  postCall = { provider: 'whisper', model: 'large-v3-turbo-q5_0' };
  await act(async () => { root.unmount(); root = create(<App />); });
  expect(text()).toContain('No Whisper model is installed');
});

test('Pyannote credits name each model license and open its source', async () => {
  await act(async () => { root = create(<App />); });
  const shown = text();
  expect(shown).toContain('by CNRS');
  expect(shown).not.toContain('Apache');
  expect(shown).toContain('THIRD_PARTY_MODELS.txt');
  const link = (label: string) => root.root.findAll((node) => node.type === 'button' && node.props.children === label);
  expect(link('CC BY 4.0')).toHaveLength(2);
  await act(async () => link('WeSpeaker ResNet34-LM')[0].props.onClick());
  await act(async () => link('onnx-community')[0].props.onClick());
  expect(openedUrls).toEqual([
    'https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM',
    'https://huggingface.co/onnx-community/pyannote-segmentation-3.0',
  ]);
});

test('missing Pyannote models name the pinned sources the repair downloads from', async () => {
  pyannoteAvailable = false;
  await act(async () => { root = create(<App />); });
  const shown = text();
  // model_integrity::PYANNOTE, not this repository or a release of the app.
  expect(shown).toContain('from their public sources on Hugging Face, each at a fixed commit');
  expect(shown).not.toContain('Protocol repository');
  expect(shown).not.toContain('GitHub release');
  expect(shown).toContain('Re-download models');
});
