import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { CatalogStatus } from '../../src/lib/model-catalog';

Object.assign(globalThis, { React });

let status: CatalogStatus;
const calls: Array<[string, unknown]> = [];
let pushStatus: ((event: { payload: CatalogStatus }) => void) | undefined;

mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (name: string, args?: unknown) => {
    calls.push([name, args]);
    return status;
  },
}));
mock.module('@tauri-apps/api/event', () => ({
  listen: async (_name: string, handler: (event: { payload: CatalogStatus }) => void) => {
    pushStatus = handler;
    return () => { pushStatus = undefined; };
  },
}));
mock.module('@/components/ui/button', () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
mock.module('@/components/ui/spinner', () => ({ Spinner: () => <span /> }));

const lib = await import('../../src/lib/model-catalog');
const { ModelUpdateControl } = await import('../../src/components/ModelUpdateControl');
const { ModelCatalogSettings, catalogLine } = await import('../../src/components/updater/ModelCatalogSettings');

const NOW = Date.parse('2026-10-27T12:00:00Z');
const base = (overrides: Partial<CatalogStatus> = {}): CatalogStatus => ({
  source: 'built-in',
  fetchedAt: null,
  lastCheckedAt: null,
  checking: false,
  error: null,
  hidden: [],
  updates: [],
  operations: [],
  updateFailures: [],
  sizesVersion: 0,
  ...overrides,
});
const update = { engine: 'whisper' as const, id: 'small', fromCommit: 'a'.repeat(40), toCommit: 'b'.repeat(40), downloadBytes: 487_601_967 };

let root: ReactTestRenderer;
const text = () => JSON.stringify(root.toJSON());
const buttons = (label: string) => root.root.findAll((node) =>
  node.type === 'button' && node.children.filter((child) => typeof child === 'string').join('') === label);
const press = async (label: string) => {
  const [button] = buttons(label);
  if (!button) throw new Error(`no ${label} button in ${text()}`);
  await act(async () => { await button.props.onClick({ stopPropagation: () => {} }); });
};

beforeEach(() => { calls.length = 0; status = base(); });
afterEach(async () => { await act(async () => root?.unmount()); });

test('a card offers an update only for an installed model and starts it', async () => {
  const catalog = base({ updates: [update] });
  await act(async () => { root = create(<ModelUpdateControl catalog={catalog} engine="whisper" id="small" installed={false} />); });
  expect(root.toJSON()).toBeNull();
  await act(async () => { root.update(<ModelUpdateControl catalog={catalog} engine="whisper" id="small" installed />); });
  expect(text()).toContain('Update available · 465 MB to download');
  await press('Update');
  expect(calls).toContainEqual(['model_update_start', { engine: 'whisper', id: 'small' }]);
  // Another model's update is not this card's.
  await act(async () => { root.update(<ModelUpdateControl catalog={catalog} engine="llama" id="small" installed />); });
  expect(root.toJSON()).toBeNull();
});

test('a running update shows its phase and can be cancelled until it installs', async () => {
  const operation = { engine: 'parakeet' as const, id: 'v3', phase: 'downloading' as const, doneBytes: 25, totalBytes: 100 };
  await act(async () => {
    root = create(<ModelUpdateControl catalog={base({ operations: [operation] })} engine="parakeet" id="v3" installed />);
  });
  expect(text()).toContain('Downloading the update… 25%');
  await press('Cancel');
  expect(calls).toContainEqual(['model_update_cancel', { engine: 'parakeet', id: 'v3' }]);
  await act(async () => {
    root.update(<ModelUpdateControl catalog={base({ operations: [{ ...operation, phase: 'waiting' }] })} engine="parakeet" id="v3" installed />);
  });
  expect(text()).toContain('installs once recordings, imports and summaries have finished');
  await act(async () => {
    root.update(<ModelUpdateControl catalog={base({ operations: [{ ...operation, phase: 'installing' }] })} engine="parakeet" id="v3" installed />);
  });
  expect(buttons('Cancel')).toHaveLength(0);
});

test('a failed update shows why and offers another try', async () => {
  const failure = { engine: 'whisper' as const, id: 'small', message: 'The new version did not load, so the installed one was kept: bad file' };
  await act(async () => {
    root = create(<ModelUpdateControl catalog={base({ updates: [update], updateFailures: [failure] })} engine="whisper" id="small" installed />);
  });
  expect(text()).toContain('so the installed one was kept');
  expect(text()).not.toContain('Update available');
  await press('Try again');
  expect(calls).toContainEqual(['model_update_start', { engine: 'whisper', id: 'small' }]);
});

test('managers list their models again only when the list may have changed', () => {
  const key = lib.listKey(base());
  expect(lib.listKey(base({ checking: true, updates: [update] }))).toBe(key);
  const running = base({ operations: [{ engine: 'whisper', id: 'small', phase: 'downloading', doneBytes: 1, totalBytes: 9 }] });
  expect(lib.listKey(running)).not.toBe(key);
  // Progress alone does not change it.
  expect(lib.listKey({ ...running, operations: [{ ...running.operations[0], doneBytes: 5 }] })).toBe(lib.listKey(running));
  expect(lib.listKey(base({ source: 'remote', fetchedAt: NOW }))).not.toBe(key);
  // Sizes read from Hugging Face.
  expect(lib.listKey(base({ sizesVersion: 1 }))).not.toBe(key);
});

test('model sizes are exact bytes, shown in MB or GB, and nothing while unknown', () => {
  expect(lib.formatModelSize(null)).toBe('');
  expect(lib.formatModelSize(0)).toBe('');
  expect(lib.formatModelSize(9_384)).toBe('1 MB');
  expect(lib.formatModelSize(487_601_967)).toBe('465 MB');
  expect(lib.formatModelSize(1_624_555_275)).toBe('1.5 GB');
});

test('the About block says where the list comes from and checks on click', async () => {
  expect(catalogLine(base(), NOW)).toBe('Model list built into this version. Not checked yet.');
  expect(catalogLine(base({ source: 'remote', lastCheckedAt: NOW - 3_600_000 }), NOW))
    .toBe('Model list from GitHub. Your models are up to date. Last checked 1 hour ago.');
  expect(catalogLine(base({ source: 'cache', lastCheckedAt: NOW, updates: [update] }), NOW)).toContain('1 model update available');
  expect(catalogLine(base({ checking: true }), NOW)).toBe('Checking for model updates…');

  await act(async () => { root = create(<ModelCatalogSettings />); });
  expect(calls.map(([name]) => name)).toContain('model_catalog_get_status');
  status = base({ error: "Couldn't reach GitHub for the model list: offline" });
  await press('Check for model updates');
  expect(calls.map(([name]) => name)).toContain('model_catalog_check_now');
  expect(text()).toContain("Couldn't reach GitHub for the model list");
  await act(async () => pushStatus?.({ payload: base({ checking: true }) }));
  expect(buttons('Check for model updates')[0].props.disabled).toBe(true);
});

test('hidden entries are counted once however many rules they break', async () => {
  status = base({
    hidden: [
      { index: 2, id: 'small', problem: 'repo must be a Hugging Face repository' },
      { index: 2, id: 'small', problem: 'files must list one ggml-small.bin' },
      { index: 5, id: null, problem: 'id must be 1-64 lowercase letters' },
    ],
  });
  const lines = () => root.root.findAll((node) => node.type === 'p')
    .map((node) => node.children.filter((child) => typeof child === 'string').join(''));
  await act(async () => { root = create(<ModelCatalogSettings />); });
  expect(lines()).toContain('2 entries of the model list could not be used by this version.');
  await act(async () => pushStatus?.({ payload: base({ hidden: status.hidden.slice(0, 2) }) }));
  expect(lines()).toContain('1 entry of the model list could not be used by this version.');
});
