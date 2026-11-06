import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

// Settings > AI agents (#8): off by default, the privacy statement always
// shown, and the connection commands only once access is on.

const SERVER = 'C:\\Users\\Someone\\AppData\\Local\\Protocol\\protocol-mcp.exe';
let state: any;
let calls: Array<{ command: string; args?: any }>;
let copied: string[];

const status = (enabled: boolean) => ({
  ...state,
  enabled,
});

mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }));
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: any) => {
    calls.push({ command, args });
    if (command === 'get_agent_access') return status(state.enabled);
    if (command === 'set_agent_access') {
      state.enabled = args.enabled;
      return status(state.enabled);
    }
    throw new Error(command);
  },
}));

const { AgentAccessSettings, AGENT_PRIVACY } = await import('../src/components/AgentAccessSettings');

let root: ReactTestRenderer;
const text = () => JSON.stringify(root.toJSON());
const render = async () => {
  await act(async () => {
    root = create(<AgentAccessSettings />);
  });
};
const toggle = (value: boolean) =>
  act(async () => {
    // The Switch and the Radix root under it both carry the handler.
    root.root.findAll((node) => node.props.id === 'agent-access' && typeof node.props.onCheckedChange === 'function')[0].props.onCheckedChange(value);
  });

beforeEach(() => {
  state = {
    enabled: false,
    databasePath: 'C:\\Users\\Someone\\AppData\\Local\\Protocol\\data\\meeting_minutes.sqlite',
    command: SERVER,
    args: [],
    serverFound: true,
    translocated: false,
    claudeCodeCommand: `claude mcp add --scope user protocol -- "${SERVER}"`,
    claudeDesktopConfig: JSON.stringify({ mcpServers: { protocol: { command: SERVER, args: [] } } }, null, 2),
  };
  calls = [];
  copied = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (value: string) => { copied.push(value); } } },
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
});

test('off: the privacy statement and no command', async () => {
  await render();
  expect(text()).toContain('Anthropic');
  expect(AGENT_PRIVACY).toContain("It can't change anything");
  expect(text()).not.toContain('claude mcp add');
  expect(text()).not.toContain('mcpServers');
});

test('turning it on shows the commands with the real path, and Copy copies them', async () => {
  await render();
  await toggle(true);
  expect(calls).toContainEqual({ command: 'set_agent_access', args: { enabled: true } });
  expect(text()).toContain('claude mcp add --scope user protocol --');
  expect(text()).toContain('protocol-mcp.exe');
  expect(text()).toContain('Edit Config');

  const copyCode = root.root.find((node) => node.type === 'button' && node.props['aria-label'] === 'Copy Claude Code command');
  await act(async () => copyCode.props.onClick());
  expect(copied).toEqual([state.claudeCodeCommand]);
  const copyDesktop = root.root.find((node) => node.type === 'button' && node.props['aria-label'] === 'Copy Claude Desktop configuration');
  await act(async () => copyDesktop.props.onClick());
  expect(JSON.parse(copied[1]).mcpServers.protocol.command).toBe(SERVER);

  await toggle(false);
  expect(text()).not.toContain('claude mcp add');
});

test('a translocated macOS app asks to be moved instead of showing a path that will change', async () => {
  state.enabled = true;
  state.translocated = true;
  await render();
  expect(text()).toContain('Move Protocol to the Applications folder first');
  expect(text()).not.toContain('claude mcp add');
});

test('a build without the server says so', async () => {
  state.enabled = true;
  state.serverFound = false;
  await render();
  expect(text()).toContain("include the server");
  expect(text()).not.toContain('claude mcp add');
});
