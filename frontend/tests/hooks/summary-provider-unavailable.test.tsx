import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

// A settings row saved with the removed Claude Code CLI provider comes back from
// api_get_model_config with an empty provider and model (see the native
// model_config_tests). The app must load it as "no provider selected", and a
// summary must ask for another provider instead of reaching the backend.
let invokeCalls: string[];
let errors: any[][];
let settingsOpened: number;
mock.module('@/components/Sidebar/SidebarProvider', () => ({ useSidebar: () => ({ startSummaryPolling: () => {}, stopSummaryPolling: () => {} }) }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string) => {
  invokeCalls.push(command);
  switch (command) {
    case 'api_get_model_config':
      return { provider: '', model: '', whisperModel: 'large-v3', apiKey: null, ollamaEndpoint: null, summaryMaxTokens: 4096 };
    case 'api_get_summary':
      return { meeting_id: 'a', status: 'idle', data: null };
    case 'api_get_transcript_config':
    case 'api_get_api_key':
    case 'get_recording_preferences':
    case 'set_language_preference':
      return null;
    case 'get_ollama_models':
      return [];
    default:
      throw new Error(`unexpected ${command}`);
  }
} }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('sonner', () => ({ toast: { success: () => {}, error: (...args: any[]) => errors.push(args), info: () => {}, warning: () => {} } }));
mock.module('@/lib/analytics', () => ({ default: {} }));
const { ConfigProvider, useConfig } = await import('../../src/contexts/ConfigContext');
const { useSummaryGeneration } = await import('../../src/hooks/meeting-details/useSummaryGeneration');

let config: ReturnType<typeof useConfig>['modelConfig'];
let summary: ReturnType<typeof useSummaryGeneration>;
let root: ReactTestRenderer | undefined;
function Probe() {
  config = useConfig().modelConfig;
  summary = useSummaryGeneration({
    meeting: { id: 'a', created_at: '2026-10-25' },
    transcripts: [],
    modelConfig: config,
    isModelConfigLoading: false,
    selectedTemplate: 'standard',
    setAiSummary: () => {},
    onMeetingUpdated: async () => {},
    onOpenModelSettings: () => { settingsOpened++; },
  });
  return null;
}

beforeEach(async () => {
  invokeCalls = []; errors = []; settingsOpened = 0;
  await act(async () => { root = create(<ConfigProvider><Probe /></ConfigProvider>); });
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('a saved provider that is no longer offered loads as no provider selected', () => {
  expect(invokeCalls).toContain('api_get_model_config');
  expect(config.provider).toBe('');
  expect(config.model).toBe('');
  expect(config.whisperModel).toBe('large-v3');
  expect(config.summaryMaxTokens).toBe(4096);
});

test('generating without a provider asks for one and opens Model Settings', async () => {
  let started = true;
  await act(async () => { started = await summary.handleGenerateSummary(''); });
  expect(started).toBe(false);
  expect(errors).toHaveLength(1);
  expect(errors[0][0]).toBe('Choose a summary provider');
  expect(settingsOpened).toBe(1);
  expect(summary.summaryStatus).toBe('idle');
  expect(invokeCalls).not.toContain('api_get_meeting_transcripts');
  expect(invokeCalls).not.toContain('api_process_transcript');
});

test('regenerating without a provider asks for one before touching the saved summary', async () => {
  let started = true;
  await act(async () => { started = await summary.handleRegenerateSummary(''); });
  expect(started).toBe(false);
  expect(errors).toHaveLength(1);
  expect(errors[0][0]).toBe('Choose a summary provider');
  expect(settingsOpened).toBe(1);
  expect(summary.summaryStatus).toBe('idle');
  expect(invokeCalls).not.toContain('api_get_meeting_transcripts');
  expect(invokeCalls).not.toContain('api_process_transcript');
});
