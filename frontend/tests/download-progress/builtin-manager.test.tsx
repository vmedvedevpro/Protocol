import React from 'react';
import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

const listeners = new Map<string, (event: { payload: any }) => void>();
let models: any[];
let commands: string[];
mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
mock.module('@tauri-apps/api/event', () => ({ listen: async (name: string, callback: any) => {
  listeners.set(name, callback); return () => listeners.delete(name);
} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string) => {
  commands.push(command);
  if (command === 'builtin_ai_list_models') return models;
  if (command === 'builtin_ai_download_model') return new Promise(() => {});
  if (command === 'model_catalog_request_sizes') return;
  throw new Error(command);
} }));
const { BuiltInModelManager } = await import('../../src/components/BuiltInModelManager');

const message = 'Qwen3.5-2B-Q4_K_M.gguf failed its integrity check and was deleted: its SHA-256 differs from the pin. Download it again.';
const qwen = (status: object) => ({
  name: 'qwen3.5:2b', display_name: 'Qwen 3.5 2B', status, path: 'fixture.gguf',
  size_bytes: 1_280_835_840, context_size: 32768, description: '', gguf_file: 'fixture.gguf',
});
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
const button = (label: string) => root.root.findAll((node) => node.type === 'button' && textOf(node).includes(label));
const progress = (payload: object) => listeners.get('builtin-ai-download-progress')!({
  payload: { model: 'qwen3.5:2b', progress: 0, downloaded_mb: 0, total_mb: 0, speed_mbps: 0, ...payload },
});
let root: ReactTestRenderer;
beforeEach(() => { commands = []; });
afterEach(async () => { await act(async () => root?.unmount()); listeners.clear(); });

test('an error status shows its message and offers Retry', async () => {
  models = [qwen({ type: 'error', message })];
  await act(async () => { root = create(<BuiltInModelManager selectedModel="" onModelSelect={() => {}} />); });
  expect(textOf(root.root)).toContain(message);
  // Real messages carry 64-character hashes, which have no break opportunity.
  const text = root.root.find((node) => node.type === 'p' && textOf(node) === message);
  expect(text.props.className).toContain('[overflow-wrap:anywhere]');
  expect(button('Retry')).toHaveLength(1);
  await act(async () => button('Retry')[0].props.onClick({ stopPropagation: () => {} }));
  expect(commands).toContain('builtin_ai_download_model');
});

test('a failed download shows the error the backend recorded', async () => {
  models = [qwen({ type: 'downloading', progress: 40 })];
  await act(async () => { root = create(<BuiltInModelManager selectedModel="" onModelSelect={() => {}} />); });
  await act(async () => progress({ progress: 40, status: 'downloading' }));
  expect(button('Cancel')).toHaveLength(1);

  models = [qwen({ type: 'error', message })];
  await act(async () => progress({ status: 'error', error: message }));
  expect(commands.filter((command) => command === 'builtin_ai_list_models')).toHaveLength(2);
  expect(textOf(root.root)).toContain(message);
  expect(button('Retry')).toHaveLength(1);
  expect(button('Cancel')).toHaveLength(0);
});
