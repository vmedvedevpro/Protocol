import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

Object.assign(globalThis, { React });

const GPU_ID = 'large-v3-turbo-openvino-int8';
const COPY = 'large-v3-turbo-q5_0';

let whisper: any[];
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string) => {
  if (command === 'whisper_get_available_models') return whisper;
  if (command === 'parakeet_get_available_models') return [{ name: 'parakeet-tdt-0.6b-v3-int8', display_name: 'Lightning', size_bytes: 1, status: 'Available' }];
  return undefined;
} }));

const { useTranscriptionModels } = await import('../../src/hooks/useTranscriptionModels');

type Models = ReturnType<typeof useTranscriptionModels>;
let latest: Models;
function Probe({ config }: { config: { provider: string; model: string } }) {
  latest = useTranscriptionModels(config);
  return null;
}

let root: ReactTestRenderer;
const load = async (config: { provider: string; model: string }) => {
  await act(async () => { root = create(<Probe config={config} />); });
  await act(async () => { await latest.fetchModels(); });
};
const gpuVersion = (status: string) => ({ name: GPU_ID, display_name: 'Large V3 Turbo', size_bytes: 1, status, companion_of: ['large-v3-turbo', COPY] });

beforeEach(() => {
  whisper = [
    { name: 'small', display_name: 'Small', size_bytes: 1, status: 'Available' },
    { name: COPY, display_name: 'Large V3 Turbo Compressed', size_bytes: 1, status: 'Available', recommended: true },
    gpuVersion('Missing'),
  ];
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('Import and Enhance preselect what a missing Intel GPU version runs: its regular copy, not the first Whisper model', async () => {
  await load({ provider: 'whisper', model: GPU_ID });
  expect(latest.selectedModelKey).toBe(`whisper:${COPY}`);
  expect(latest.availableModels.some((model) => model.name === GPU_ID)).toBe(false);
});

test('without a copy they keep it, marked not installed, so the pass says what to download', async () => {
  whisper = [whisper[0], whisper[2]];
  await load({ provider: 'localWhisper', model: GPU_ID });
  expect(latest.selectedModelKey).toBe(`whisper:${GPU_ID}`);
  expect(latest.availableModels.find((model) => model.name === GPU_ID)?.displayName).toBe('Whisper · Large V3 Turbo · Intel GPU (not installed)');
});

test('an installed Intel GPU version is listed by its name and device', async () => {
  whisper = [whisper[0], whisper[1], gpuVersion('Available')];
  await load({ provider: 'whisper', model: GPU_ID });
  expect(latest.selectedModelKey).toBe(`whisper:${GPU_ID}`);
  expect(latest.availableModels.find((model) => model.name === GPU_ID)?.displayName).toBe('Whisper · Large V3 Turbo · Intel GPU');
});
