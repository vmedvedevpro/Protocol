import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

Object.assign(globalThis, { React });

const MB = 1024 * 1024;
const GPU_ID = 'large-v3-turbo-openvino-int8';
const COPY = 'large-v3-turbo-q5_0';
const PARAKEET = 'parakeet-tdt-0.6b-v3-int8';

let commands: Array<{ command: string; args?: any }>;
let availability: any;
let npu: any;
let modelsReady: Promise<void>;
const goNext = mock(() => {});
const startDownload = mock(() => {});

mock.module('@/contexts/OnboardingContext', () => ({ useOnboarding: () => ({ goNext }) }));
mock.module('@/contexts/OptionalModelDownloadsContext', () => ({
  OPTIONAL_WHISPER_MODEL: COPY,
  useOptionalModelDownloads: () => ({ jobs: { whisper: { status: 'idle', progress: 0 }, nemotron: { status: 'idle', progress: 0 } }, startDownload }),
}));
mock.module('@/components/onboarding/OnboardingContainer', () => ({ OnboardingContainer: ({ children }: any) => <div>{children}</div> }));
mock.module('@tauri-apps/plugin-os', () => ({ platform: () => 'windows' }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args?: any) => {
  commands.push({ command, args });
  switch (command) {
    case 'whisper_get_available_models':
      await modelsReady;
      return [
        { name: COPY, display_name: 'Large V3 Turbo Compressed', size_bytes: 547 * MB, status: 'Missing', recommended: true },
        { name: GPU_ID, display_name: 'Large V3 Turbo', size_bytes: 828 * MB, status: 'Missing', companion_of: ['large-v3-turbo', COPY] },
      ];
    case 'parakeet_get_available_models':
      return [{ name: PARAKEET, display_name: 'Lightning', size_bytes: 640 * MB, status: 'Missing', recommended: true }];
    case 'get_openvino_availability': return availability;
    case 'openvino_status':
      return {
        id: GPU_ID, name: 'x', description: '', repo: 'r', companionOf: ['large-v3-turbo', COPY], size: 828 * MB, companionInstalled: false,
        runtime: { name: 'n', version: 'v', license: { name: 'l', url: 'u' }, source: 's', downloadSize: 254 * MB, installedSize: 111 * MB, installed: null, afterRestart: null, removedAtRestart: null },
        installed: false, downloadSize: 1082 * MB, refused: null, downloading: null, progress: null, stopped: null, removesRuntime: true,
      };
    case 'parakeet_npu_status':
      if (!npu) throw new Error('unknown command');
      return npu;
    case 'model_catalog_model_size':
      return args.id === PARAKEET ? 640 * MB : args.id === COPY ? 547 * MB : null;
    case 'get_local_stack_status': return { whisper: {} };
    case 'get_cuda_reconfiguration_status': return { compiledBackend: 'vulkan', driverState: 'ok' };
    default: return undefined;
  }
} }));

const { SetupOverviewStep } = await import('../src/components/onboarding/steps/SetupOverviewStep');

let root: ReactTestRenderer;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const render = async () => {
  await act(async () => { root = create(<SetupOverviewStep />); await settle(); await settle(); });
};
const text = () => JSON.stringify(root.toJSON());
const label = (node: any): string => node.children.map((child: any) => (typeof child === 'string' ? child : label(child))).join('');
const checkboxes = () => root.root.findAll((node) => node.type === 'button' && node.props.role === 'checkbox');
const continueSetup = () => act(async () => {
  root.root.find((node) => node.type === 'button' && label(node) === "Let's Go").props.onClick();
  await settle();
});

beforeEach(() => {
  commands = [];
  modelsReady = Promise.resolve();
  availability = { offer: true, gpu: 'Intel(R) Arc(TM) B390 GPU', reason: null, device: null, mismatch: null };
  npu = { present: true, state: 'needs_runtime', active: false, reason: null };
  goNext.mockClear(); startDownload.mockClear();
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('first-run setup offers the same pair, both selected, Parakeet locked on', async () => {
  await render();
  expect(text()).toContain('For this computer');
  expect(text()).toContain('Parakeet Lightning');
  expect(text()).toContain('Whisper Large V3 Turbo');
  expect(text()).toContain('Intel NPU');
  expect(text()).toContain('Intel GPU');
  expect(text()).toContain('1.1 GB');
  expect(text()).toContain('Parakeet writes live text on the Intel NPU.');
  expect(text()).not.toContain('DirectML');
  const [parakeet, whisper, nemotron] = checkboxes();
  expect(parakeet.props['aria-checked']).toBe(true);
  expect(parakeet.props.disabled).toBe(true);
  expect(whisper.props['aria-checked']).toBe(true);
  expect(nemotron.props['aria-checked']).toBe(false);
  await continueSetup();
  // On an Intel GPU, Whisper is its Intel GPU version, chosen natively when it ends.
  expect(commands.find((entry) => entry.command === 'openvino_download')?.args).toEqual({ id: GPU_ID, choose: true });
  expect(startDownload).not.toHaveBeenCalled();
  expect(goNext).toHaveBeenCalled();
});

test('Whisper can be unchecked; another PC gets the Compressed copy through the optional job', async () => {
  await render();
  const whisper = root.root.findAll((node) => typeof node.props.onCheckedChange === 'function' && node.props.checked === true && !node.props.disabled)[0];
  await act(async () => { whisper.props.onCheckedChange(false); await settle(); });
  await continueSetup();
  expect(commands.find((entry) => entry.command === 'openvino_download')).toBeUndefined();
  await act(async () => root.unmount());

  availability = { offer: false, gpu: 'NVIDIA', reason: 'not Intel', device: null, mismatch: null };
  npu = null;
  commands = [];
  await render();
  expect(text()).toContain('Whisper Large V3 Turbo Compressed');
  expect(text()).not.toContain('Intel GPU');
  expect(text()).toContain('Parakeet writes live text on the processor.');
  await continueSetup();
  expect(startDownload).toHaveBeenCalledWith('whisper');
  expect(commands.find((entry) => entry.command === 'openvino_download')).toBeUndefined();
});

test('an NPU-only PC also downloads Intel\'s libraries for Parakeet', async () => {
  availability = { offer: false, gpu: 'NVIDIA', reason: 'not Intel', device: null, mismatch: null };
  await render();
  expect(text()).toContain("With Intel's libraries for the NPU · 254 MB.");
  await continueSetup();
  expect(commands.filter((entry) => entry.command === 'openvino_runtime_download')).toHaveLength(1);
});

test("Let's Go waits for the pair: an early click cannot pick the wrong Whisper", async () => {
  let ready: () => void = () => {};
  modelsReady = new Promise((resolve) => { ready = resolve; });
  await act(async () => { root = create(<SetupOverviewStep />); await settle(); });
  const button = () => root.root.find((node) => node.type === 'button' && label(node) === "Let's Go");
  expect(button().props.disabled).toBe(true);
  await act(async () => { button().props.onClick(); await settle(); });
  expect(startDownload).not.toHaveBeenCalled();
  expect(commands.find((entry) => entry.command === 'openvino_download')).toBeUndefined();
  await act(async () => { ready(); await settle(); await settle(); });
  expect(button().props.disabled).toBe(false);
  await continueSetup();
  expect(commands.find((entry) => entry.command === 'openvino_download')?.args).toEqual({ id: GPU_ID, choose: true });
});
