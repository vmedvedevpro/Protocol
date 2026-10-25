import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { UpdaterSnapshot } from '../../src/lib/updater';

const storage = new Map<string, string>();
const timers = new Map<number, () => void>();
let nextTimer = 1;
Object.assign(globalThis, {
  React,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
  window: {
    setInterval: (fn: () => void) => { timers.set(nextTimer, fn); return nextTimer++; },
    clearInterval: (id: number) => timers.delete(id),
  },
});

let status: UpdaterSnapshot;
const reports: unknown[] = [];
let pushStatus: ((event: { payload: UpdaterSnapshot }) => void) | undefined;
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (name: string, args?: { activities?: unknown }) => {
    if (name === 'updater_set_ui_activity') { reports.push(args?.activities); return undefined; }
    return status;
  },
}));
mock.module('@tauri-apps/api/event', () => ({
  listen: async (_name: string, handler: (event: { payload: UpdaterSnapshot }) => void) => {
    pushStatus = handler;
    return () => { pushStatus = undefined; };
  },
}));
const toasts: string[] = [];
const toast = Object.assign((title: string) => { toasts.push(title); }, { success: (title: string) => { toasts.push(title); } });
mock.module('sonner', () => ({ toast }));
let recording = 'idle';
mock.module('@/contexts/RecordingStateContext', () => ({
  RecordingStatus: { IDLE: 'idle', RECORDING: 'recording', STOPPING: 'stopping', PROCESSING_TRANSCRIPTS: 'processing', SAVING: 'saving' },
  useRecordingState: () => ({ status: recording }),
}));

const { UpdaterProvider } = await import('../../src/contexts/UpdaterContext');
const { UpdateToasts, SEEN_KEY } = await import('../../src/components/updater/UpdateToasts');
const { UpdaterActivityReporter } = await import('../../src/components/updater/UpdaterActivityReporter');
const { markUiActivity } = await import('../../src/lib/updater');
const { snapshot, offered } = await import('./fixtures');

let root: ReactTestRenderer;
const push = async (next: UpdaterSnapshot) => {
  status = next;
  await act(async () => pushStatus?.({ payload: next }));
};
const mountToasts = async () => {
  await act(async () => { root = create(<UpdaterProvider><UpdateToasts /></UpdaterProvider>); });
};

beforeEach(() => {
  storage.clear();
  toasts.length = 0;
  reports.length = 0;
  timers.clear();
  recording = 'idle';
  status = snapshot();
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('one toast per version, across restarts', async () => {
  await mountToasts();
  await push(snapshot({ offer: offered() }));
  await push(snapshot({ offer: offered(), lastCheckedAt: 1 }));
  expect(toasts).toEqual(['Protocol 0.3.1 is available']);
  await act(async () => root.unmount());
  await mountToasts();
  await push(snapshot({ offer: offered() }));
  expect(toasts).toEqual(['Protocol 0.3.1 is available']);
  await push(snapshot({ offer: offered('0.3.2') }));
  expect(toasts).toEqual(['Protocol 0.3.1 is available', 'Protocol 0.3.2 is available']);
  expect(JSON.parse(storage.get(SEEN_KEY) ?? '{}')).toEqual({ 'available:0.3.1': true, 'available:0.3.2': true });
});

test('a download finished in this session is announced, one restored at launch is not', async () => {
  status = snapshot({ offer: offered('0.3.1', { downloaded: true }) });
  await mountToasts();
  await push(status);
  expect(toasts).toEqual([]);
  await push(snapshot({ offer: offered('0.3.2') }));
  await push(snapshot({ offer: offered('0.3.2', { downloaded: true }) }));
  expect(toasts).toEqual(['Protocol 0.3.2 is available', 'Protocol 0.3.2 is ready to install']);
});

test('toasts wait while recording; the updated toast appears once', async () => {
  await mountToasts();
  await push(snapshot({ offer: offered(), busyReasons: ['recording'] }));
  expect(toasts).toEqual([]);
  await push(snapshot({ offer: offered() }));
  expect(toasts).toEqual(['Protocol 0.3.1 is available']);
  await push(snapshot({ currentVersion: '0.3.1', updatedFrom: '0.3.0' }));
  await push(snapshot({ currentVersion: '0.3.1', updatedFrom: '0.3.0', lastCheckedAt: 2 }));
  expect(toasts).toEqual(['Protocol 0.3.1 is available', 'Updated to Protocol 0.3.1']);
});

test('the reporter sends the whole set on change, renews it, and clears it on unmount', async () => {
  recording = 'saving';
  await act(async () => { root = create(<UpdaterActivityReporter />); });
  expect(reports.at(-1)).toEqual(['recordingSave']);
  markUiActivity('postCall', true);
  expect(reports.at(-1)).toEqual(['recordingSave', 'postCall']);
  const sent = reports.length;
  for (const tick of timers.values()) tick();
  expect(reports.length).toBe(sent + 1);
  recording = 'idle';
  await act(async () => root.update(<UpdaterActivityReporter />));
  expect(reports.at(-1)).toEqual(['postCall']);
  markUiActivity('postCall', false);
  expect(reports.at(-1)).toEqual([]);
  const quiet = reports.length;
  for (const tick of timers.values()) tick();
  expect(reports.length).toBe(quiet);
  await act(async () => root.unmount());
  expect(reports.at(-1)).toEqual([]);
  expect(timers.size).toBe(0);
});
