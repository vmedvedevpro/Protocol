import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

Object.assign(globalThis, { React });

let commands: Array<[string, unknown]>;
const model = (name: string, display_name: string, status: unknown, recommended = false) => ({
  name, display_name, recommended, status, path: '', size_bytes: 670_000_000, accuracy: 'High', speed: 'Fast', quantization: 'Int8', languages: ['en'],
});
let models: ReturnType<typeof model>[];
const v2 = 'parakeet-tdt-0.6b-v2-int8';
const update = { engine: 'parakeet', id: v2, fromCommit: 'a'.repeat(40), toCommit: 'b'.repeat(40), downloadBytes: 9_000_000 };
const catalog = {
  source: 'built-in', fetchedAt: null, lastCheckedAt: null, checking: false, error: null,
  hidden: [], updates: [update], operations: [], updateFailures: [], checkFailures: [], sizesVersion: 0,
};

mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args?: unknown) => {
  commands.push([command, args]);
  if (command === 'parakeet_init') return;
  if (command === 'parakeet_get_available_models') return models;
  if (command === 'model_catalog_get_status') return catalog;
  if (command === 'model_catalog_request_sizes') return;
  throw new Error(command);
} }));
const { ParakeetModelManager } = await import('../../src/components/ParakeetModelManager');

let root: ReactTestRenderer;
const text = () => JSON.stringify(root.toJSON());
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
// The row of the model named `name`.
const row = (name: string) => root.root.findAll((node) => node.type === 'li' && textOf(node).includes(name))[0];
beforeEach(() => {
  commands = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('an installed Parakeet v2 keeps its row, with its update, marked as no longer offered', async () => {
  const onModelSelect = mock(() => {});
  models = [model('parakeet-tdt-0.6b-v3-int8', 'Multilingual', 'Available', true), model(v2, 'Compact', 'Available')];
  await act(async () => { root = create(<ParakeetModelManager onModelSelect={onModelSelect} />); });
  expect(textOf(row('Compact'))).toContain('Update available');
  expect(textOf(row('Compact'))).toContain('No longer offered');
  expect(textOf(row('Multilingual'))).not.toContain('No longer offered');
  // Rows never choose a model: the pickers in Settings do, and they leave v2
  // out (tests/lib/speech-models.test.ts).
  expect(root.root.findAll((node) => node.type === 'li' && typeof node.props.onClick === 'function')).toHaveLength(0);
  expect(onModelSelect).not.toHaveBeenCalled();
});

test('a row says where its model is in use', async () => {
  models = [model('parakeet-tdt-0.6b-v3-int8', 'Multilingual', 'Available', true)];
  await act(async () => {
    root = create(<ParakeetModelManager usageFor={(name) => (name === 'parakeet-tdt-0.6b-v3-int8' ? ['During meetings'] : [])} />);
  });
  expect(textOf(row('Multilingual'))).toContain('During meetings');
});

test('Parakeet v2 is not listed once it is not on disk', async () => {
  models = [model('parakeet-tdt-0.6b-v3-int8', 'Multilingual', 'Available', true), model(v2, 'Compact', 'Missing')];
  await act(async () => { root = create(<ParakeetModelManager />); });
  expect(text()).toContain('Multilingual');
  expect(text()).not.toContain('Compact');
});
