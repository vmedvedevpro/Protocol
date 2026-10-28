import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

Object.assign(globalThis, { React });

const listeners = new Map<string, (event: { payload: any }) => void>();
let commands: string[];
const model = (name: string, display_name: string, tier: 'basic' | null, recommended = false, size_bytes: number | null = 100 * 1024 * 1024) => ({
  name, display_name, tier, recommended, path: '', size_bytes, accuracy: 'Good', speed: 'Fast', status: 'Missing', languages: ['*'],
});
let models: ReturnType<typeof model>[];
const catalog = (overrides: Record<string, unknown> = {}) => ({
  source: 'built-in', fetchedAt: null, lastCheckedAt: null, checking: false, error: null,
  hidden: [], updates: [], operations: [], updateFailures: [], checkFailures: [], sizesVersion: 0, ...overrides,
});

mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module('@tauri-apps/api/event', () => ({ listen: async (name: string, callback: any) => {
  listeners.set(name, callback); return () => listeners.delete(name);
} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string) => {
  commands.push(command);
  if (command === 'whisper_get_available_models') return models;
  if (command === 'model_catalog_get_status') return catalog();
  if (command === 'whisper_init') return;
  if (command === 'model_catalog_request_sizes') return;
  throw new Error(command);
} }));
const { ModelManager } = await import('../../src/components/WhisperModelManager');

let root: ReactTestRenderer;
const text = () => JSON.stringify(root.toJSON());
// "N more models": the list shows installed models and the recommendation.
const showMore = () => act(async () => {
  root.root.find((node) => node.type === 'button' && node.props['aria-expanded'] === false).props.onClick();
});
beforeEach(() => {
  commands = [];
  models = [model('small', 'Small', 'basic'), model('large-v3-turbo', 'Large V3 Turbo', 'basic', true)];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
});
afterEach(async () => { await act(async () => root?.unmount()); listeners.clear(); });

test('names, tiers, order and the recommendation come from the catalog', async () => {
  models = [model('tiny', 'Tiny', null), ...models];
  await act(async () => { root = create(<ModelManager />); });
  // Nothing is installed: the catalog's recommendation is offered, the rest wait.
  expect(text()).toContain('Large V3 Turbo');
  expect(text()).toContain('Recommended');
  expect(text()).not.toContain('Small');
  await showMore();
  const shown = text();
  expect(shown.indexOf('Large V3 Turbo')).toBeLessThan(shown.indexOf('Small'));
  // Basic models before the others, each in catalog order.
  expect(shown.indexOf('Small')).toBeLessThan(shown.indexOf('Tiny'));
});

test('installed models lead the list, named without their engine', async () => {
  models = [model('small', 'Small', 'basic'), { ...model('tiny-q5_1', 'Whisper tiny-q5_1', null), status: 'Available' }];
  await act(async () => { root = create(<ModelManager />); });
  const shown = text();
  expect(shown).toContain('tiny-q5_1');
  expect(shown).not.toContain('Whisper tiny-q5_1');
  expect(shown).toContain('Installed');
  expect(shown).not.toContain('Small');
});

test('a new model list or a finished update lists the models again', async () => {
  await act(async () => { root = create(<ModelManager />); });
  const listed = () => commands.filter((command) => command === 'whisper_get_available_models').length;
  const before = listed();
  models = [...models, model('medium-q5_0', 'Medium', 'basic')];
  // Progress of a running update does not.
  const operation = { engine: 'whisper', id: 'small', phase: 'downloading', doneBytes: 1, totalBytes: 9 };
  await act(async () => listeners.get('model-catalog-changed')!({ payload: catalog({ operations: [operation] }) }));
  await act(async () => listeners.get('model-catalog-changed')!({ payload: catalog({ operations: [{ ...operation, doneBytes: 5 }] }) }));
  expect(listed()).toBe(before + 1);
  await act(async () => listeners.get('model-catalog-changed')!({ payload: catalog({ source: 'remote', fetchedAt: 1 }) }));
  expect(listed()).toBe(before + 2);
  await showMore();
  expect(text()).toContain('Medium');
});

test('sizes come from Hugging Face: asked for on mount, shown when they arrive, never guessed', async () => {
  models = [model('small', 'Small', 'basic', false, null)];
  await act(async () => { root = create(<ModelManager />); });
  await showMore();
  expect(commands).toContain('model_catalog_request_sizes');
  expect(text()).not.toContain(' MB');
  const listed = () => commands.filter((command) => command === 'whisper_get_available_models').length;
  const before = listed();
  models = [model('small', 'Small', 'basic', false, 487_601_967)];
  await act(async () => listeners.get('model-catalog-changed')!({ payload: catalog({ sizesVersion: 1 }) }));
  expect(listed()).toBe(before + 1);
  expect(text()).toContain('465 MB');
});
