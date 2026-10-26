import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';
import type { UpdaterSnapshot } from '../../src/lib/updater';

Object.assign(globalThis, { React });

let status: UpdaterSnapshot;
const calls: Array<[string, unknown]> = [];
let installRefusal: unknown = null;
let pushStatus: ((event: { payload: UpdaterSnapshot }) => void) | undefined;

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (name: string, args?: unknown) => {
    calls.push([name, args]);
    if (name === 'updater_install_now' && installRefusal) throw installRefusal;
    if (name === 'updater_set_ui_activity' || name === 'open_external_url') return undefined;
    return status;
  },
}));
mock.module('@tauri-apps/api/event', () => ({
  listen: async (_name: string, handler: (event: { payload: UpdaterSnapshot }) => void) => {
    pushStatus = handler;
    return () => { pushStatus = undefined; };
  },
}));
mock.module('@/components/ui/button', () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
mock.module('@/components/ui/progress', () => ({ Progress: (props: any) => <progress {...props} /> }));
mock.module('@/components/ui/spinner', () => ({ Spinner: () => <span /> }));
mock.module('@/components/ui/switch', () => ({ Switch: (props: any) => <input type="checkbox" {...props} /> }));

const { UpdaterProvider, useUpdater, REFUSAL_MS } = await import('../../src/contexts/UpdaterContext');
const { UpdatePanel, MAC_PERMISSIONS_NOTE } = await import('../../src/components/updater/UpdatePanel');
const { UpdateSettings } = await import('../../src/components/updater/UpdateSettings');
const { snapshot, offered } = await import('./fixtures');

let root: ReactTestRenderer;
const onClose = mock(() => {});

function Panels() {
  const updater = useUpdater();
  return <>{updater?.status && <UpdatePanel onClose={onClose} />}<UpdateSettings /></>;
}

const mount = async () => {
  await act(async () => { root = create(<UpdaterProvider><Panels /></UpdaterProvider>); });
};
const push = async (next: UpdaterSnapshot) => {
  status = next;
  await act(async () => pushStatus?.({ payload: next }));
};
const text = () => JSON.stringify(root.toJSON());
const buttons = (label: string) => root.root.findAll((node) =>
  node.type === 'button' && node.children.filter((child) => typeof child === 'string').join('') === label);
const press = async (label: string) => {
  const [button] = buttons(label);
  if (!button) throw new Error(`no ${label} button in ${text()}`);
  await act(async () => { await button.props.onClick(); });
};

beforeEach(() => {
  status = snapshot();
  calls.length = 0;
  installRefusal = null;
  onClose.mockClear();
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('an offered release downloads only on click', async () => {
  await mount();
  await push(snapshot({ offer: offered() }));
  expect(calls.some(([name]) => name === 'updater_download_now')).toBe(false);
  expect(text()).toContain('Protocol 0.3.1 is available');
  expect(text()).toContain('Recording no longer stops on sleep.');
  expect(buttons('Restart and update')).toHaveLength(0);
  await press('Download');
  expect(calls.filter(([name]) => name === 'updater_download_now')).toHaveLength(1);
});

test('a downloaded release offers Restart and update, and a busy refusal explains itself', async () => {
  await mount();
  await push(snapshot({ offer: offered('0.3.1', { downloaded: true }) }));
  expect(text()).toContain('Protocol 0.3.1 is ready');
  expect(buttons('Download')).toHaveLength(0);
  installRefusal = { kind: 'busy', reasons: ['import'] };
  await press('Restart and update');
  expect(text()).toContain("Protocol can't restart while an audio import is running.");
  for (const button of buttons('Restart and update')) expect(button.props.disabled).toBe(true);
});

test('Restart and update is disabled while native code reports work', async () => {
  await mount();
  await push(snapshot({ offer: offered('0.3.1', { downloaded: true }), busyReasons: ['recording'] }));
  for (const button of buttons('Restart and update')) expect(button.props.disabled).toBe(true);
  expect(text()).toContain('a recording is in progress');
  await push(snapshot({ offer: offered('0.3.1', { downloaded: true }) }));
  for (const button of buttons('Restart and update')) expect(button.props.disabled).toBe(false);
});

test('a refusal that the status never lists clears on its own', async () => {
  jest.useFakeTimers();
  try {
    await mount();
    await push(snapshot({ offer: offered('0.3.1', { downloaded: true }) }));
    installRefusal = { kind: 'busy', reasons: ['speechEngine'] };
    await press('Restart and update');
    expect(text()).toContain('the speech engine is busy');
    for (const button of buttons('Restart and update')) expect(button.props.disabled).toBe(true);
    await act(async () => { jest.advanceTimersByTime(REFUSAL_MS); });
    expect(text()).not.toContain('the speech engine is busy');
    for (const button of buttons('Restart and update')) expect(button.props.disabled).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test('Restart and update waits for a running check in the panel and in Settings', async () => {
  await mount();
  await push(snapshot({ offer: offered('0.3.1', { downloaded: true }), activity: { state: 'checking', manual: true } }));
  const restart = buttons('Restart and update');
  expect(restart).toHaveLength(2);
  for (const button of restart) expect(button.props.disabled).toBe(true);
});

test('a download waiting for the recording cannot be started twice', async () => {
  await mount();
  await push(snapshot({ offer: offered('0.3.1', { waitingForRecording: true }) }));
  for (const button of buttons('Download')) expect(button.props.disabled).toBe(true);
  expect(text()).toContain('starts after the recording');
});

test('macOS shows the permissions warning; apt installs link to GitHub', async () => {
  await mount();
  await push(snapshot({ platform: 'macos', support: { kind: 'updatable', install: 'app' }, offer: offered() }));
  expect(text()).toContain(MAC_PERMISSIONS_NOTE);
  await push(snapshot({ platform: 'linux', support: { kind: 'manualOnly', install: 'deb' }, offer: offered('0.3.1', { manualOnly: true }) }));
  expect(text()).not.toContain(MAC_PERMISSIONS_NOTE);
  expect(buttons('Download')).toHaveLength(0);
  await press('Download from GitHub');
  expect(calls).toContainEqual(['open_external_url', { url: 'https://github.com/vmedvedevpro/Protocol/releases/tag/v0.3.1' }]);
});

test('Settings checks on request and toggles the automatic check', async () => {
  await mount();
  await press('Check for updates');
  expect(calls.some(([name]) => name === 'updater_check_now')).toBe(true);
  const toggle = root.root.findByProps({ 'aria-labelledby': 'auto-check-label' });
  await act(async () => { await toggle.props.onCheckedChange(false); });
  expect(calls).toContainEqual(['updater_set_auto_check', { enabled: false }]);
});

test('a failed manual check is reported while a release is offered', async () => {
  await mount();
  const error = { kind: 'network', action: 'check', message: 'offline', at: 1, background: false } as const;
  await push(snapshot({ offer: offered(), error }));
  expect(text()).toContain("Couldn't reach GitHub.");
  expect(buttons('Download')).not.toHaveLength(0);
  await push(snapshot({ offer: offered(), error: { ...error, background: true } }));
  expect(text()).not.toContain("Couldn't reach GitHub.");
});

test('a copy that cannot update says why and offers the releases page', async () => {
  status = snapshot({ support: { kind: 'off', reason: 'notInstalled' } });
  await mount();
  expect(text()).toContain('not installed by the Protocol installer');
  expect(root.root.findAllByProps({ 'aria-labelledby': 'auto-check-label' })).toHaveLength(0);
  expect(buttons('Open releases page')).toHaveLength(1);
});
