import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, mock, test } from 'bun:test';

Object.assign(globalThis, { React });

let npu: any;
mock.module('next/link', () => ({ default: ({ children }: any) => children }));
mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module('@/hooks/usePlatform', () => ({ usePlatform: () => 'windows' }));
mock.module('@/hooks/useLabs', () => ({ useLabs: () => ({ labs: { parakeetGpu: true } }) }));
mock.module('@/hooks/useVoiceProfiles', () => ({ useVoiceProfiles: () => ({ profiles: [], modelsReady: true }) }));
mock.module('@/lib/labs-features', () => ({ setLabsFeature: async () => {}, syncLabsFromBackend: async () => {} }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string) => {
  if (command === 'parakeet_npu_status') {
    if (!npu) throw new Error('unknown command');
    return npu;
  }
  return undefined;
} }));

const { LabsSettings } = await import('../src/components/LabsSettings');

let root: ReactTestRenderer;
const render = async () => {
  await act(async () => { root = create(<LabsSettings />); await new Promise((resolve) => setTimeout(resolve, 0)); });
};
afterEach(async () => { await act(async () => root?.unmount()); });

test('Parakeet on the GPU is not offered while the Intel NPU prepares or runs Parakeet', async () => {
  for (const state of ['preparing', 'ready']) {
    npu = { present: true, state, active: state === 'ready', reason: null };
    await render();
    expect(JSON.stringify(root.toJSON())).not.toContain('Parakeet on the GPU');
    await act(async () => root.unmount());
  }
});

test('Parakeet on the GPU stays without an NPU, before it is ready, after it failed, and without #66', async () => {
  for (const status of [
    { present: false, state: 'absent', active: false, reason: null },
    { present: true, state: 'waiting', active: false, reason: null },
    { present: true, state: 'failed', active: false, reason: 'x' },
    null,
  ]) {
    npu = status;
    await render();
    expect(JSON.stringify(root.toJSON())).toContain('Parakeet on the GPU');
    await act(async () => root.unmount());
  }
});
