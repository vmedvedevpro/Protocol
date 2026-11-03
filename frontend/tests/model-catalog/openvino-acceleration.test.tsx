import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

Object.assign(globalThis, { React });

const listeners = new Map<string, (event: { payload: any }) => void>();
let commands: Array<{ command: string; args?: any }>;
let availability: Record<string, unknown> | Error;
let companion: Record<string, any> | null;
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
  if (command === 'openvino_status') return args.whisperModel === 'large-v3-turbo-q5_0' ? companion : null;
  if (command === 'openvino_download') return downloadResult();
  if (['openvino_cancel', 'openvino_remove', 'openvino_retry', 'open_external_url'].includes(command)) return;
  throw new Error(command);
} }));
const { OpenVinoAcceleration } = await import('../../src/components/OpenVinoAcceleration');

const MB = 1024 * 1024;
const LICENSE_URL = 'https://www.intel.com/content/dam/develop/external/us/en/documents/intel-openvino-license-agreements.pdf';

let root: ReactTestRenderer;
const text = () => JSON.stringify(root.toJSON());
const button = (label: string) => root.root.find((node) => node.type === 'button' && node.props['aria-label'] === label);
const buttonWithText = (label: string) =>
  root.root.find((node) => node.type === 'button' && node.props.children === label);
// A click starts a promise chain (invoke, then state); let it run out.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const click = (label: string) => act(async () => { button(label).props.onClick(); await settle(); });
const render = async (models = ['small', 'large-v3-turbo-q5_0']) => {
  await act(async () => { root = create(<OpenVinoAcceleration whisperModels={models} />); await settle(); });
};
const fire = (event: string) => act(async () => { listeners.get(event)!({ payload: null }); await settle(); });

beforeEach(() => {
  commands = [];
  availability = { offer: true, gpu: 'Intel(R) Arc(TM) B390 GPU', reason: null, device: null, mismatch: null };
  companion = {
    id: 'large-v3-turbo-openvino-int8',
    name: 'Large V3 Turbo for Intel GPUs',
    description: 'Runs on an Intel GPU',
    repo: 'OpenVINO/whisper-large-v3-turbo-int8-ov',
    companionOf: ['large-v3-turbo', 'large-v3-turbo-q5_0'],
    size: 828 * MB,
    companionInstalled: false,
    runtime: {
      name: 'OpenVINO GenAI',
      version: '2026.4.1.0',
      license: { name: 'Intel OpenVINO Distribution License', url: LICENSE_URL },
      source: 'storage.openvinotoolkit.org',
      downloadSize: 254 * MB,
      installedSize: 111 * MB,
      installed: null,
      afterRestart: null,
    },
    installed: false,
    downloadSize: (254 + 828) * MB,
    refused: null,
    downloading: null,
    progress: null,
    stopped: null,
    removesRuntime: false,
  };
  downloadResult = async () => {};
});
afterEach(async () => { await act(async () => root?.unmount()); listeners.clear(); });

test('the row says what one click downloads, from where, under which licence and how big', async () => {
  await render();
  expect(text()).toContain('Large V3 Turbo for Intel GPUs');
  expect(text()).toContain('Intel(R) Arc(TM) B390 GPU');
  expect(text()).toContain("Intel's OpenVINO GenAI 2026.4.1.0 libraries, from storage.openvinotoolkit.org (254 MB download, 111 MB on disk)");
  expect(text()).toContain('The model, from Hugging Face (OpenVINO/whisper-large-v3-turbo-int8-ov), 828 MB');
  // What the click fetches: both parts.
  expect(text()).toContain('1.1 GB');
  // Asked for each model in use until one has a companion; nothing downloaded.
  expect(commands.filter(({ command }) => command === 'openvino_status').map(({ args }) => args.whisperModel))
    .toEqual(['small', 'large-v3-turbo-q5_0']);
  expect(commands.some(({ command }) => command === 'openvino_download')).toBe(false);

  await act(async () => { buttonWithText('Intel OpenVINO Distribution License').props.onClick(); await settle(); });
  expect(commands.find(({ command }) => command === 'open_external_url')?.args).toEqual({ url: LICENSE_URL });

  await click('Download Large V3 Turbo for Intel GPUs');
  expect(commands.filter(({ command }) => command === 'openvino_download').map(({ args }) => args))
    .toEqual([{ id: 'large-v3-turbo-openvino-int8' }]);
});

test('nothing is offered where whisper.cpp does not run on an Intel GPU, or for a model without a companion', async () => {
  availability = { offer: false, gpu: 'NVIDIA GeForce RTX 4060 Laptop GPU', reason: 'not an Intel GPU', device: null, mismatch: null };
  await render(['large-v3-turbo-q5_0']);
  expect(root.toJSON()).toBeNull();
  await act(async () => root.unmount());

  // A build without OpenVINO has no such command.
  availability = new Error('get_openvino_availability not found');
  await render(['large-v3-turbo-q5_0']);
  expect(root.toJSON()).toBeNull();
  await act(async () => root.unmount());

  availability = { offer: true, gpu: 'GPU', reason: null, device: null, mismatch: null };
  await render(['small']);
  expect(root.toJSON()).toBeNull();
});

test('a running download shows its progress and can be cancelled; then it can be tried again', async () => {
  // Before its first report: the percentage alone.
  companion = { ...companion!, downloading: 0, progress: { done: 0, total: 0 } };
  await render(['large-v3-turbo-q5_0']);
  expect(text()).toContain('Downloading… ');
  expect(text()).not.toContain('MB of ');
  await act(async () => root.unmount());

  // The runtime is in, so the row's size is now the model's alone; the label
  // keeps counting the whole download.
  companion = { ...companion!, downloadSize: 828 * MB, downloading: 23, progress: { done: 250 * MB, total: (254 + 828) * MB } };
  await render(['large-v3-turbo-q5_0']);
  expect(text()).toContain('23');
  expect(text()).toContain(' · 250 MB of 1.1 GB');
  await click('Cancel downloading Large V3 Turbo for Intel GPUs');
  expect(commands.some(({ command }) => command === 'openvino_cancel')).toBe(true);

  // Cancelled: back to Download, no error.
  companion = { ...companion!, downloading: null };
  await fire('openvino-companion-changed');
  expect(text()).toContain('Download');
  expect(text()).not.toContain('Retry');
});

test('once both are installed the device is shown, and a mismatch is said, not hidden', async () => {
  companion = {
    ...companion!,
    companionInstalled: true,
    installed: true,
    downloadSize: 0,
    runtime: { ...companion!.runtime, installed: '2026.4.1.0' },
  };
  availability = { ...(availability as object), device: 'GPU' };
  await render(['large-v3-turbo-q5_0']);
  expect(text()).toContain('Installed');
  expect(text()).toContain('Used on the Intel GPU');
  expect(text()).toContain('Whisper runs on GPU with OpenVINO.');
  await act(async () => root.unmount());

  availability = { offer: true, gpu: 'Intel(R) Arc(TM) B390 GPU', reason: null, device: null, mismatch: 'OpenVINO lists no Intel GPU that is Intel(R) Arc(TM) B390 GPU, so Whisper stays on Vulkan' };
  await render(['large-v3-turbo-q5_0']);
  expect(text()).toContain('OpenVINO cannot run Whisper here: OpenVINO lists no Intel GPU');
});

test('a companion whose runtime was removed offers to download the runtime again', async () => {
  companion = { ...companion!, companionInstalled: true, downloadSize: 254 * MB };
  await render(['large-v3-turbo-q5_0']);
  expect(text()).toContain('254 MB');
  expect(text()).toContain('828 MB · installed');
  await click('Download Large V3 Turbo for Intel GPUs');
  expect(commands.some(({ command }) => command === 'openvino_download')).toBe(true);
});

test('a newer runtime in the model list is offered as an update, then used after a restart', async () => {
  companion = {
    ...companion!,
    companionInstalled: true,
    installed: true,
    downloadSize: 260 * MB,
    runtime: { ...companion!.runtime, version: '2026.5.0.0', downloadSize: 260 * MB, installed: '2026.4.1.0' },
  };
  await render(['large-v3-turbo-q5_0']);
  expect(text()).toContain('OpenVINO GenAI 2026.5.0.0 is available · 260 MB to download');
  await click('Update OpenVINO GenAI to 2026.5.0.0');
  expect(commands.filter(({ command }) => command === 'openvino_download')).toHaveLength(1);

  // The update fetches the runtime alone: its bytes, not what is on disk.
  companion = { ...companion!, downloading: 12, progress: { done: 31 * MB, total: 260 * MB } };
  await fire('openvino-companion-changed');
  expect(text()).toContain(' · 31 MB of 260 MB');
  companion = { ...companion!, downloading: null, progress: null };

  companion = { ...companion!, runtime: { ...companion!.runtime, installed: '2026.5.0.0', afterRestart: '2026.5.0.0' } };
  await fire('model-catalog-changed');
  expect(text()).not.toContain('is available');
  expect(text()).toContain('OpenVINO GenAI 2026.5.0.0 is installed. Protocol uses it after a restart.');
});

test('after Protocol closed inside OpenVINO the row says so and can turn it on again', async () => {
  const stopped = 'Protocol closed unexpectedly the last time OpenVINO was preparing the model for the GPU, so Whisper runs on Vulkan. Try OpenVINO again in Settings › Transcription.';
  companion = { ...companion!, companionInstalled: true, installed: true, downloadSize: 0, stopped,
    runtime: { ...companion!.runtime, installed: '2026.4.1.0' } };
  await render(['large-v3-turbo-q5_0']);
  expect(text()).toContain('Protocol closed unexpectedly the last time OpenVINO was preparing the model for the GPU');
  await act(async () => { buttonWithText('Try OpenVINO again').props.onClick(); await settle(); });
  expect(commands.some(({ command }) => command === 'openvino_retry')).toBe(true);

  companion = { ...companion!, stopped: null };
  await fire('openvino-companion-changed');
  expect(text()).not.toContain('closed unexpectedly');
});

test('libraries left without the model can be completed or removed', async () => {
  // Another companion keeps the libraries: removing this one would not delete them.
  companion = { ...companion!, downloadSize: 828 * MB, runtime: { ...companion!.runtime, installed: '2026.4.1.0' } };
  await render(['large-v3-turbo-q5_0']);
  expect(text()).toContain('2026.4.1.0 installed');
  expect(text()).not.toContain('Download fetches only the model');
  expect(() => buttonWithText('Remove the libraries')).toThrow();

  companion = { ...companion!, removesRuntime: true };
  await render(['large-v3-turbo-q5_0']);
  expect(text()).toContain('2026.4.1.0 installed');
  expect(text()).toContain('Download fetches only the model');
  expect(text()).toContain('828 MB');
  await act(async () => { buttonWithText('Remove the libraries').props.onClick(); await settle(); });
  expect(commands.filter(({ command }) => command === 'openvino_remove').map(({ args }) => args))
    .toEqual([{ id: 'large-v3-turbo-openvino-int8' }]);
});

test('a failed download shows why and offers a retry; a runtime this version cannot run is refused', async () => {
  downloadResult = async () => { throw 'OpenVINO GenAI 2026.4.1.0 archive failed its integrity check and was deleted'; };
  await render(['large-v3-turbo-q5_0']);
  await click('Download Large V3 Turbo for Intel GPUs');
  expect(text()).toContain('failed its integrity check');
  expect(text()).toContain('Retry');
  await act(async () => root.unmount());

  companion = { ...companion!, runtime: null, downloadSize: null, refused: 'The model list offers OpenVINO GenAI 2027.0.0.0, which this version of Protocol cannot run. Update Protocol to use it.' };
  await render(['large-v3-turbo-q5_0']);
  expect(text()).toContain('which this version of Protocol cannot run');
  expect(root.root.findAll((node) => node.type === 'button' && node.props['aria-label'] === 'Download Large V3 Turbo for Intel GPUs')).toHaveLength(0);
});
