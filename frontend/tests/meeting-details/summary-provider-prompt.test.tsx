import React, { useState } from 'react';
import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

// The meeting page with a settings row saved for a provider the app no longer
// offers: api_get_model_config returns provider '' (see the native
// model_config_tests). ConfigContext, the summary hook, PageContent and
// MeetingDocument are real; the transcript, header, player and editors are stubs.
let calls: string[];
let toasts: Array<{ message: string; options?: any }>;
const line = { id: 't1', text: 'We agreed to ship on Friday.', timestamp: '00:00', audio_start_time: 0, audio_end_time: 3, speaker: 'Speaker 1' };
const nothing = () => null;
const wrap = ({ children }: any) => <div>{children}</div>;

mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string) => {
  calls.push(command);
  switch (command) {
    case 'api_get_model_config':
      return { provider: '', model: '', whisperModel: 'large-v3', apiKey: null, ollamaEndpoint: null, summaryMaxTokens: null };
    case 'api_get_summary':
      return { meeting_id: 'm1', status: 'idle', data: null };
    case 'api_get_meeting_transcripts':
      return { transcripts: [line], total_count: 1, has_more: false };
    case 'api_process_transcript':
      return { process_id: 'run-1' };
    case 'get_ollama_models':
      return [];
    default:
      return null;
  }
} }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
const record = (message: string, options?: any) => { toasts.push({ message, options }); };
mock.module('sonner', () => ({ toast: { success: record, error: record, info: record, warning: record } }));
mock.module('@/lib/analytics', () => ({ default: new Proxy({}, { get: () => async () => {} }) }));
mock.module('framer-motion', () => ({ motion: { div: wrap } }));
mock.module('@/components/Sidebar/SidebarProvider', () => ({ useSidebar: () => ({ setCurrentMeeting: () => {}, startSummaryPolling: () => {}, stopSummaryPolling: () => {} }) }));
mock.module('@/contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ people: [] }) }));
mock.module('@/lib/workspace-api', () => ({
  announceChange: () => {},
  askMeeting: async () => null,
  getMeetingGroup: async () => null,
  getMeetingNotes: async () => null,
  listActionItems: async () => [],
  listUnsyncedActionMeetings: async () => [],
  onWorkspaceChange: () => () => {},
  saveMeetingNotes: async () => {},
  setMeetingGroup: async () => {},
  syncAiActionItems: async () => [],
}));
mock.module('@/lib/meeting-actions', () => ({ deleteMeetings: async () => {}, renameMeeting: async () => true }));
mock.module('@/hooks/useLabs', () => ({ useLabs: () => ({ labs: {}, ready: true }) }));
mock.module('@/hooks/useUserName', () => ({ useUserName: () => 'You' }));
mock.module('@/hooks/useWaveform', () => ({ useWaveform: () => null }));
mock.module('@/hooks/useMeetingAudio', () => ({
  PLAYBACK_RATES: [1],
  SLOW_PLAYBACK_RATES: [1],
  useMeetingAudio: () => ({ status: 'unavailable', path: null, playing: false, currentTime: 0, seek: () => {} }),
}));
mock.module('@/hooks/meeting-details/useTemplates', () => ({ useTemplates: () => ({
  selectedTemplate: 'standard',
  availableTemplates: [{ id: 'standard', name: 'Standard', description: '' }],
  handleTemplateSelection: () => {},
  saveCustomTemplate: async () => {},
  deleteCustomTemplate: async () => {},
}) }));
mock.module('@/hooks/meeting-details/useCopyOperations', () => ({ useCopyOperations: () => ({}) }));
mock.module('@/hooks/meeting-details/useMeetingOperations', () => ({ useMeetingOperations: () => ({}) }));
// Post-call processing is done as soon as the page opens.
mock.module('@/components/MeetingDetails/PostCallProcessingDialog', () => ({ PostCallProcessingDialog: ({ enabled, onComplete }: any) => {
  React.useEffect(() => { if (enabled) onComplete(); }, [enabled]);
  return null;
} }));
mock.module('@/components/MeetingDetails/TemplateEditorModal', () => ({ TemplateEditorModal: nothing }));
mock.module('@/components/MeetingDetails/MeetingExportDialog', () => ({ MeetingExportDialog: nothing }));
mock.module('@/components/VirtualizedTranscriptView', () => ({ VirtualizedTranscriptView: nothing }));
mock.module('@/components/meeting/MeetingHeader', () => ({ MeetingHeader: nothing }));
mock.module('@/components/meeting/AudioPlayerBar', () => ({ AudioPlayerBar: nothing }));
mock.module('@/components/people/PersonCard', () => ({ PersonCard: nothing }));
mock.module('@/components/people/SpeakerIdentityDialog', () => ({ SpeakerIdentityDialog: nothing }));
mock.module('@/components/editor/NotesEditor', () => ({ NotesEditor: nothing }));
mock.module('@/components/actions/ActionItemsList', () => ({ ActionItemsList: nothing }));
mock.module('@/components/chat/ChatThread', () => ({ ChatThread: nothing }));
mock.module('@/components/LanguagePickerPopover', () => ({ LanguagePickerPopover: nothing }));
mock.module('@/components/ModelSettingsModal', () => ({ ModelSettingsModal: () => <p>Model settings form</p> }));
mock.module('@/components/ui/button', () => ({ Button: ({ loading, variant, size, asChild, ...props }: any) => <button {...props} /> }));
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: wrap, DialogDescription: wrap, DialogFooter: wrap, DialogHeader: wrap, DialogTitle: wrap,
}));
mock.module('@/components/ui/popover', () => ({ Popover: wrap, PopoverContent: wrap, PopoverTrigger: wrap }));
mock.module('@/components/ui/select', () => ({ Select: wrap, SelectContent: wrap, SelectItem: wrap, SelectTrigger: wrap, SelectValue: wrap }));
mock.module('@/components/ui/tabs', () => ({ Tabs: wrap, TabsContent: wrap, TabsList: wrap, TabsTrigger: wrap }));
mock.module('@/components/ui/textarea', () => ({ Textarea: (props: any) => <textarea {...props} /> }));
mock.module('@/components/ui/visually-hidden', () => ({ VisuallyHidden: wrap }));
mock.module('@/components/ui/surface', () => ({ Skeleton: nothing }));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  };
}
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: memoryStorage() });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage() });

const { ConfigProvider, useConfig } = await import('../../src/contexts/ConfigContext');
const { default: PageContent } = await import('../../src/app/meeting-details/page-content');

const meeting = { id: 'm1', title: 'Weekly sync', created_at: '2026-10-25T10:00:00Z', transcripts: [line] };
let setModelConfig: ReturnType<typeof useConfig>['setModelConfig'];
let armAutoSummary: () => void;
function ConfigProbe() {
  setModelConfig = useConfig().setModelConfig;
  return null;
}
// Stands in for app/meeting-details/page.tsx: auto-summary is armed once after
// a recording and disarmed through onAutoGenerateComplete.
type PageProps = { summary?: any; edited?: boolean; tick?: number };
function MeetingPage({ summary = null, edited = false }: PageProps) {
  const [armed, setArmed] = useState(false);
  armAutoSummary = () => setArmed(true);
  return (
    <PageContent
      meeting={meeting}
      summaryData={summary}
      summaryUserEdited={edited}
      isPostCallRecording
      shouldAutoGenerate={armed}
      onAutoGenerateComplete={() => setArmed(false)}
    />
  );
}
const tree = (props: PageProps = {}) => <ConfigProvider><ConfigProbe /><MeetingPage {...props} /></ConfigProvider>;
const prompts = () => toasts.filter((toast) => toast.message === 'Choose a summary provider');
const textOf = (node: ReactTestInstance | string): string => (typeof node === 'string' ? node : node.children.map(textOf).join(''));
const button = (label: string) => root!.root.find((node) => node.type === 'button' && textOf(node).trim() === label);
const pageText = () => textOf(root!.root);

let root: ReactTestRenderer | undefined;
async function render(props: PageProps = {}) {
  await act(async () => { root = create(tree(props)); });
}
beforeEach(() => {
  calls = []; toasts = [];
  sessionStorage.clear();
});
afterEach(async () => { await act(async () => root?.unmount()); });

test('a refused auto-summary does not start when a provider is selected but not saved', async () => {
  await render();
  await act(async () => armAutoSummary());
  expect(prompts()).toHaveLength(1);
  // What Model Settings does on a provider change, before Save.
  await act(async () => setModelConfig((prev) => ({ ...prev, provider: 'claude', model: 'claude-3-5-sonnet-latest' })));
  expect(calls).not.toContain('api_get_meeting_transcripts');
  expect(calls).not.toContain('api_process_transcript');
  expect(prompts()).toHaveLength(1);
});

test('re-renders after the refusal add no prompt and no summary call', async () => {
  await render();
  await act(async () => armAutoSummary());
  for (let tick = 1; tick <= 5; tick++) await act(async () => root!.update(tree({ tick })));
  expect(prompts()).toHaveLength(1);
  expect(prompts()[0].options.id).toBe('choose-summary-provider');
  expect(calls).not.toContain('api_get_meeting_transcripts');
  expect(calls).not.toContain('api_process_transcript');
});

test('a refused regeneration keeps the dialog, the Edited badge and the replace warning', async () => {
  await render({ summary: { markdown: '## Summary\n- Ship on Friday, as edited by hand' }, edited: true });
  expect(pageText()).toContain('Edited');
  await act(async () => button('Regenerate').props.onClick());
  await act(async () => button('Replace and regenerate').props.onClick());
  expect(prompts()).toHaveLength(1);
  expect(calls).not.toContain('api_process_transcript');
  expect(pageText()).toContain('Regenerate the summary');
  expect(pageText()).toContain('Regenerating replaces those edits.');
  expect(pageText()).toContain('Edited');
  expect(button('Replace and regenerate')).toBeDefined();
});
