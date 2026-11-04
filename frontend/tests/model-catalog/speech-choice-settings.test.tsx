import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

Object.assign(globalThis, { React });

const MB = 1024 * 1024;
const GPU_ID = 'large-v3-turbo-openvino-int8';
const COPY = 'large-v3-turbo-q5_0';
const PARAKEET = 'parakeet-tdt-0.6b-v3-int8';

let commands: Array<{ command: string; args?: any }>;
let installed: { parakeet: boolean; copy: boolean; gpu: boolean };
let availability: any;
let npu: any;
let labs: Record<string, boolean>;
let whisperManagerProps: any;
let storage: Map<string, string>;
const jobs = { whisper: { status: 'idle', progress: 0 }, nemotron: { status: 'idle', progress: 0 } };

function companion() {
  return {
    id: GPU_ID, name: 'Large V3 Turbo for Intel GPUs', description: '', repo: 'OpenVINO/x', companionOf: ['large-v3-turbo', COPY],
    size: 828 * MB, companionInstalled: installed.gpu,
    runtime: { name: 'OpenVINO GenAI', version: '2026.4.1.0', license: { name: 'L', url: 'u' }, source: 's', downloadSize: 254 * MB, installedSize: 111 * MB, installed: installed.gpu ? '2026.4.1.0' : null, afterRestart: null, removedAtRestart: null },
    installed: installed.gpu, downloadSize: installed.gpu ? null : 1082 * MB, refused: null, downloading: null, progress: null, stopped: null, removesRuntime: true,
  };
}

mock.module('@/contexts/OptionalModelDownloadsContext', () => ({
  OPTIONAL_WHISPER_MODEL: COPY,
  useOptionalModelDownloads: () => ({ jobs, startDownload: () => {}, uninstallModel: () => {} }),
}));
mock.module('@/hooks/useLabs', () => ({ useLabs: () => ({ labs }) }));
mock.module('@/components/WhisperModelManager', () => ({ ModelManager: (props: any) => { whisperManagerProps = props; return null; } }));
mock.module('@/components/ParakeetModelManager', () => ({ ParakeetModelManager: () => null }));
mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args?: any) => {
  commands.push({ command, args });
  switch (command) {
    case 'whisper_get_available_models':
      return [
        { name: COPY, display_name: 'Large V3 Turbo Compressed', size_bytes: 547 * MB, status: installed.copy ? 'Available' : 'Missing', recommended: true },
        { name: GPU_ID, display_name: 'Large V3 Turbo', size_bytes: 828 * MB, status: installed.gpu ? 'Available' : 'Missing', companion_of: ['large-v3-turbo', COPY] },
      ];
    case 'parakeet_get_available_models':
      return [{ name: PARAKEET, display_name: 'Lightning', size_bytes: 640 * MB, status: installed.parakeet ? 'Available' : 'Missing', recommended: true }];
    case 'get_openvino_availability': return availability;
    case 'openvino_status': return companion();
    case 'parakeet_npu_status':
      if (!npu) throw new Error('unknown command parakeet_npu_status');
      return npu;
    case 'api_get_post_call_transcript_config': return { provider: 'whisper', model: COPY };
    case 'api_get_vocabulary': return { global: '', meeting: '' };
    case 'get_recording_preferences': return { real_time_transcription: false };
    case 'get_local_stack_status': return { whisper: { openvino: null } };
    case 'speech_choice_copy_retires': return false;
    default: return undefined;
  }
} }));

const { TranscriptSettings } = await import('../../src/components/TranscriptSettings');

let root: ReactTestRenderer;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const render = async () => {
  await act(async () => {
    root = create(<TranscriptSettings transcriptModelConfig={{ provider: 'parakeet', model: PARAKEET }} setTranscriptModelConfig={() => {}} />);
    await settle();
    await settle();
  });
};
const text = () => JSON.stringify(root.toJSON());
const label = (node: any): string => node.children.map((child: any) => (typeof child === 'string' ? child : label(child))).join('');
const button = (name: string) => root.root.find((node) => node.type === 'button' && label(node) === name);
const click = (name: string) => act(async () => { button(name).props.onClick(); await settle(); await settle(); });
const called = (command: string) => commands.filter((entry) => entry.command === command);

beforeEach(() => {
  commands = [];
  installed = { parakeet: true, copy: true, gpu: false };
  availability = { offer: true, gpu: 'Intel(R) Arc(TM) B390 GPU', reason: null, device: null, mismatch: null };
  npu = { present: true, state: 'needs_runtime', active: false, reason: null };
  labs = {};
  whisperManagerProps = undefined;
  storage = new Map();
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: Object.assign(new EventTarget(), { setTimeout, clearTimeout }) });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => null, removeItem: () => {} } });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  });
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('N2: after an update an Intel PC is offered its GPU and NPU at the top; Switch downloads and chooses the Intel GPU version', async () => {
  await render();
  const offer = root.root.find((node) => node.type === 'section' && node.props['aria-label'] === 'Intel GPU and NPU offer');
  expect(label(offer)).toContain('Protocol can use your Intel GPU and NPU');
  expect(label(offer)).toContain('Whisper switches to its Intel GPU version · 1.1 GB');
  // It sits above Speech to text.
  expect(text().indexOf('Protocol can use your Intel GPU and NPU')).toBeLessThan(text().indexOf('Speech to text'));
  await click('Switch');
  expect(called('openvino_download')[0].args).toEqual({ id: GPU_ID, choose: true });
  expect(text()).not.toContain('Protocol can use your Intel GPU and NPU');
});

test('an NPU-only PC is offered the NPU, and Switch downloads only Intel\'s libraries', async () => {
  availability = { offer: false, gpu: 'NVIDIA', reason: 'not Intel', device: null, mismatch: null };
  await render();
  expect(text()).toContain('Protocol can use your Intel NPU');
  expect(text()).toContain("Live text takes less power. Protocol downloads Intel's libraries for the NPU · 254 MB");
  await click('Switch');
  expect(called('openvino_runtime_download')).toHaveLength(1);
  expect(called('openvino_download')).toHaveLength(0);
});

test('Not now is remembered per device, and the card keeps a way back to the offer', async () => {
  await render();
  await click('Not now');
  expect(JSON.parse(storage.get('meetily-intel-offer-dismissed')!)).toEqual(['Intel GPU', 'Intel NPU']);
  expect(text()).not.toContain('Protocol can use your Intel GPU and NPU');
  await act(async () => root.unmount());
  await render();
  expect(text()).not.toContain('Protocol can use your Intel GPU and NPU');
  await click('Use your Intel GPU and NPU…');
  expect(storage.has('meetily-intel-offer-dismissed')).toBe(false);
  expect(text()).toContain('Protocol can use your Intel GPU and NPU');
});

test('a fresh install gets the card, not the offer; a build without the NPU commands offers the GPU alone', async () => {
  installed = { parakeet: false, copy: false, gpu: false };
  await render();
  expect(text()).not.toContain('Protocol can use your Intel');
  expect(text()).toContain('Download both');
  expect(text()).toContain("No speech model is on this computer yet, so recording can't start.");
  await act(async () => root.unmount());

  installed = { parakeet: true, copy: true, gpu: false };
  npu = null;
  await render();
  expect(text()).toContain('Protocol can use your Intel GPU');
  expect(text()).not.toContain('Protocol can use your Intel GPU and NPU');
  expect(text()).not.toContain('Intel NPU');
});

test('nothing is offered once this computer uses what it has', async () => {
  installed = { parakeet: true, copy: false, gpu: true };
  npu = { present: true, state: 'ready', active: true, reason: null };
  await render();
  expect(text()).not.toContain('Protocol can use your Intel');
  expect(text()).not.toContain('Use your Intel');
});

test('All models stays collapsed until opened, also from the live select', async () => {
  await render();
  expect(whisperManagerProps).toBeUndefined();
  const live = root.root.findAllByProps({ name: 'live-model' })[0];
  await act(async () => { live.props.onValueChange('__all-models'); await settle(); });
  expect(whisperManagerProps).toBeDefined();
  // Opening the list saves nothing.
  expect(called('api_save_transcript_config')).toHaveLength(0);
});

test('the Labs GPU badge for Parakeet goes while the Intel NPU runs Parakeet', async () => {
  labs = { parakeetGpu: true };
  npu = { present: true, state: 'ready', active: true, reason: null };
  await render();
  expect(text()).not.toContain('GPU · Labs');
  await act(async () => root.unmount());
  npu = { present: true, state: 'failed', active: false, reason: 'x' };
  await render();
  expect(text()).toContain('GPU · Labs');
});
