import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

Object.assign(globalThis, { React });

const listeners = new Map<string, (event: { payload: any }) => void>();
let commands: Array<{ command: string; args?: any }>;
let availability: { available: boolean; device: string | null; reason: string | null } | Error;
let companion: Record<string, unknown> | null;
let downloadResult: () => Promise<void>;

mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module('@tauri-apps/api/event', () => ({ listen: async (name: string, callback: any) => {
  listeners.set(name, callback); return () => listeners.delete(name);
} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args?: any) => {
  commands.push({ command, args });
  if (command === 'get_openvino_availability') {
    if (availability instanceof Error) throw availability;
    return availability;
  }
  if (command === 'openvino_companion_status') return args.whisperModel === 'large-v3-turbo-q5_0' ? companion : null;
  if (command === 'openvino_companion_download') return downloadResult();
  if (command === 'openvino_companion_cancel' || command === 'openvino_companion_delete') return;
  throw new Error(command);
} }));
const { OpenVinoCompanion } = await import('../../src/components/OpenVinoCompanion');

let root: ReactTestRenderer;
const text = () => JSON.stringify(root.toJSON());
const button = (label: string) => root.root.find((node) => node.type === 'button' && node.props['aria-label'] === label);
// A click starts a promise chain (invoke, then state); let it run out.
const click = (label: string) => act(async () => {
  button(label).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(() => {
  commands = [];
  availability = { available: true, device: 'Intel(R) Arc(TM) B390 GPU (iGPU)', reason: null };
  companion = {
    id: 'large-v3-turbo-openvino-int8',
    name: 'Large V3 Turbo for Intel GPUs',
    description: 'Runs on an Intel GPU',
    companionOf: ['large-v3-turbo', 'large-v3-turbo-q5_0'],
    size: 820 * 1024 * 1024,
    installed: false,
    downloading: null,
  };
  downloadResult = async () => {};
});
afterEach(async () => { await act(async () => root?.unmount()); listeners.clear(); });

test('the companion of the model in use is offered with what it is, its size and why', async () => {
  await act(async () => { root = create(<OpenVinoCompanion whisperModels={['small', 'large-v3-turbo-q5_0']} />); });
  expect(text()).toContain('Large V3 Turbo for Intel GPUs');
  expect(text()).toContain('820 MB');
  expect(text()).toContain('Intel(R) Arc(TM) B390 GPU (iGPU)');
  expect(text()).toContain('through OpenVINO instead of Vulkan');
  // Asked for each model in use until one has a companion; nothing downloaded.
  expect(commands.filter(({ command }) => command === 'openvino_companion_status').map(({ args }) => args.whisperModel))
    .toEqual(['small', 'large-v3-turbo-q5_0']);
  expect(commands.some(({ command }) => command === 'openvino_companion_download')).toBe(false);

  await click('Download Large V3 Turbo for Intel GPUs');
  expect(commands.find(({ command }) => command === 'openvino_companion_download')?.args).toEqual({ id: 'large-v3-turbo-openvino-int8' });
});

test('nothing is shown where OpenVINO cannot run, or for a model without a companion', async () => {
  availability = { available: false, device: null, reason: 'The GPU is not an Intel GPU' };
  await act(async () => { root = create(<OpenVinoCompanion whisperModels={['large-v3-turbo-q5_0']} />); });
  expect(root.toJSON()).toBeNull();
  expect(commands.some(({ command }) => command === 'openvino_companion_status')).toBe(false);
  await act(async () => root.unmount());

  // A build without OpenVINO has no such command.
  availability = new Error('get_openvino_availability not found');
  await act(async () => { root = create(<OpenVinoCompanion whisperModels={['large-v3-turbo-q5_0']} />); });
  expect(root.toJSON()).toBeNull();
  await act(async () => root.unmount());

  availability = { available: true, device: 'GPU', reason: null };
  await act(async () => { root = create(<OpenVinoCompanion whisperModels={['small']} />); });
  expect(root.toJSON()).toBeNull();
});

test('a running download shows its progress and can be cancelled; the state follows native events', async () => {
  companion = { ...companion!, downloading: 40 };
  await act(async () => { root = create(<OpenVinoCompanion whisperModels={['large-v3-turbo-q5_0']} />); });
  expect(text()).toContain('Downloading… ');
  await click('Cancel downloading Large V3 Turbo for Intel GPUs');
  expect(commands.some(({ command }) => command === 'openvino_companion_cancel')).toBe(true);

  companion = { ...companion!, downloading: null, installed: true };
  await act(async () => {
    listeners.get('openvino-companion-changed')!({ payload: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(text()).toContain('Installed');
  expect(text()).toContain('Used on the Intel GPU');
});

test('a failed download shows why and offers a retry; a cancelled one does not', async () => {
  downloadResult = async () => { throw 'openvino_decoder_model.bin failed its integrity check and was deleted'; };
  await act(async () => { root = create(<OpenVinoCompanion whisperModels={['large-v3-turbo-q5_0']} />); });
  await click('Download Large V3 Turbo for Intel GPUs');
  expect(text()).toContain('failed its integrity check');
  expect(text()).toContain('Retry');
  await act(async () => root.unmount());

  downloadResult = async () => { throw 'The download was cancelled'; };
  await act(async () => { root = create(<OpenVinoCompanion whisperModels={['large-v3-turbo-q5_0']} />); });
  await click('Download Large V3 Turbo for Intel GPUs');
  expect(text()).not.toContain('Retry');
  expect(text()).toContain('Download');
});
