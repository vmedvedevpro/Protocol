import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, mock, test } from 'bun:test';

const session = new Map<string, string>();
Object.assign(globalThis, {
  React,
  sessionStorage: {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
    removeItem: (key: string) => session.delete(key),
  },
});

const handlers = new Map<string, (event: { payload: unknown }) => void>();
mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  },
}));
const toast = Object.assign(() => {}, { error: () => {} });
mock.module('sonner', () => ({ toast }));
const stops: unknown[][] = [];
mock.module('@/hooks/useRecordingStop', () => ({
  useRecordingStop: () => ({ handleRecordingStop: async (...args: unknown[]) => { stops.push(args); } }),
}));
mock.module('@/contexts/PostCallJobsContext', () => ({
  PostCallJobsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { RecordingPostProcessingProvider } = await import('../../src/contexts/RecordingPostProcessingProvider');

let root: ReactTestRenderer;
afterEach(async () => { await act(async () => root.unmount()); });

test('the native stop id reaches the save, so its answer names the right stop', async () => {
  await act(async () => { root = create(<RecordingPostProcessingProvider>{null}</RecordingPostProcessingProvider>); });
  await act(async () => {
    handlers.get('recording-stop-complete')?.({
      payload: { call_api: true, stop_id: 12, folder_path: 'C:/recordings/Weekly sync', meeting_name: 'Weekly sync' },
    });
  });
  // A payload without an id (the dev preview sends one) still saves.
  await act(async () => {
    handlers.get('recording-stop-complete')?.({ payload: { call_api: true, folder_path: null } });
  });
  expect(stops).toEqual([[true, 12], [true, undefined]]);
  expect(session.get('last_recording_folder_path')).toBeUndefined();
});
