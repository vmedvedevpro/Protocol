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
// The card of the model named `name`: the outermost clickable box holding it.
const card = (name: string) => root.root.findAll((node) =>
  node.type === 'div' && typeof node.props.onClick === 'function' && textOf(node).includes(name))[0];
beforeEach(() => {
  commands = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('an installed Parakeet v2 keeps its card, with its update, but is not offered as a choice', async () => {
  const onModelSelect = mock(() => {});
  models = [model('parakeet-tdt-0.6b-v3-int8', 'Multilingual', 'Available', true), model(v2, 'Compact', 'Available')];
  await act(async () => { root = create(<ParakeetModelManager onModelSelect={onModelSelect} />); });
  expect(textOf(card('Compact'))).toContain('Update available');
  await act(async () => card('Compact').props.onClick());
  expect(onModelSelect).not.toHaveBeenCalled();
  await act(async () => card('Multilingual').props.onClick());
  expect(onModelSelect).toHaveBeenCalledWith('parakeet-tdt-0.6b-v3-int8');
});

test('Parakeet v2 is not listed once it is not on disk', async () => {
  models = [model('parakeet-tdt-0.6b-v3-int8', 'Multilingual', 'Available', true), model(v2, 'Compact', 'Missing')];
  await act(async () => { root = create(<ParakeetModelManager />); });
  expect(text()).toContain('Multilingual');
  expect(text()).not.toContain('Compact');
});
