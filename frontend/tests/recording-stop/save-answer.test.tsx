import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

// The hook waits 4.5 s for late transcript events and 350 ms before it opens
// the meeting; run those timers at once, and count them so a test can wait
// until the hook is done.
const realSetTimeout = globalThis.setTimeout;
let timers = 0;
const session = new Map<string, string>();
Object.assign(globalThis, {
  React,
  setTimeout: (fn: () => void) => {
    timers++;
    return realSetTimeout(() => { timers--; fn(); }, 0);
  },
  sessionStorage: {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
    removeItem: (key: string) => session.delete(key),
  },
  window: {},
});

// Everything the hook does that matters here, in order.
let events: string[];
let saveMeeting: () => Promise<{ meeting_id: string }>;
let answerFails: boolean;
let status: string;

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (name: string, args?: { stopId?: number; outcome?: string }) => {
    if (name === 'recording_save_finished') {
      if (answerFails) throw new Error('IPC failed');
      events.push(`answer ${args?.stopId} ${args?.outcome}`);
      return undefined;
    }
    events.push(name);
    return undefined;
  },
}));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
mock.module('next/navigation', () => ({ useRouter: () => ({ push: (path: string) => events.push(`open ${path}`) }) }));
const toast = Object.assign(() => {}, { message: () => {}, error: () => {}, warning: () => {}, success: () => {} });
mock.module('sonner', () => ({ toast }));
let duration: number;
mock.module('@/contexts/RecordingStateContext', () => ({
  RecordingStatus: {
    IDLE: 'idle', STOPPING: 'stopping', PROCESSING_TRANSCRIPTS: 'processing',
    SAVING: 'saving', COMPLETED: 'completed', ERROR: 'error',
  },
  useRecordingState: () => ({
    status,
    setStatus: (next: string) => { status = next; },
    isStopping: false,
    isProcessing: false,
    isSaving: false,
    recordingDuration: duration,
  }),
}));
mock.module('@/contexts/TranscriptContext', () => ({
  useTranscripts: () => ({
    transcriptsRef: { current: [{ text: 'Hello there', speaker: 'You' }] },
    flushBuffer: () => {},
    clearTranscripts: () => events.push('clear transcripts'),
    meetingTitle: 'Weekly sync',
    markMeetingAsSaved: async () => { events.push('recovery record cleared'); },
  }),
}));
mock.module('@/components/Sidebar/SidebarProvider', () => ({
  useSidebar: () => ({
    refetchMeetings: async () => {},
    setCurrentMeeting: () => {},
    setMeetings: () => {},
    meetings: [],
    setIsMeetingActive: () => {},
  }),
}));
mock.module('@/services/storageService', () => ({
  storageService: {
    saveMeeting: () => saveMeeting(),
    getMeeting: async (id: string) => ({ id, title: 'Weekly sync' }),
  },
}));
mock.module('@/services/transcriptService', () => ({
  transcriptService: { getTranscriptionStatus: async () => ({ is_processing: false, chunks_in_queue: 0, last_activity_ms: 0 }) },
}));
mock.module('@/lib/summary-language-preferences', () => ({
  applyPinnedSummaryLanguageToMeeting: async () => true,
  detectAndCacheSummaryLanguage: async () => ({}),
}));
mock.module('@/lib/live-session', () => ({
  endLiveSession: () => {},
  finalLiveTitle: (title: string) => title,
  readLiveNotes: () => null,
  writeLiveTitle: () => {},
}));
mock.module('@/lib/workspace-api', () => ({ announceChange: () => {}, saveMeetingNotes: async () => {} }));
mock.module('@/lib/meeting-automation', () => ({ endAutomatedRecording: () => {} }));
mock.module('@/lib/groups', () => ({ readPendingGroup: () => null, writePendingGroup: () => {} }));

const { useRecordingStop } = await import('../../src/hooks/useRecordingStop');
const { reportSaveFinished } = await import('../../src/lib/recording-save');

let stop: (callApi: boolean, stopId?: number) => Promise<void>;
function Probe() {
  stop = useRecordingStop(() => {}, () => {}).handleRecordingStop;
  return null;
}

let root: ReactTestRenderer;
beforeEach(async () => {
  events = [];
  answerFails = false;
  duration = 60;
  status = 'recording';
  session.clear();
  session.set('last_recording_folder_path', 'C:/recordings/Weekly sync');
  saveMeeting = async () => { events.push('meeting saved'); return { meeting_id: 'm1' }; };
  await act(async () => { root = create(<Probe />); });
});
afterEach(async () => { await act(async () => root.unmount()); });

async function waitFor(done: () => boolean) {
  for (let i = 0; i < 1000 && !done(); i++) await new Promise((resolve) => realSetTimeout(resolve, 1));
}

const run = (callApi: boolean, stopId?: number) => act(async () => {
  await stop(callApi, stopId);
  // The meeting opens from a timer.
  await waitFor(() => timers === 0);
});

test('a saved meeting answers the native stop after the save, then opens the meeting', async () => {
  await run(true, 7);
  expect(events).toEqual([
    'meeting saved',
    'recovery record cleared',
    'answer 7 saved',
    'open /meeting-details?id=m1&source=recording',
    'clear transcripts',
  ]);
  expect(status).toBe('idle');
});

test('a take under 10 seconds is answered as discarded once its folder is gone', async () => {
  duration = 5;
  await act(async () => { root.update(<Probe />); });
  await run(true, 3);
  expect(events).toEqual(['clear transcripts', 'discard_recording_folder', 'answer 3 discarded']);
});

test('a failed save is answered as failed, never as saved', async () => {
  saveMeeting = async () => { throw new Error('disk full'); };
  await run(true, 4);
  expect(events).toEqual(['answer 4 failed']);
  expect(status).toBe('error');
});

test('a stop that skips the save is answered as not saved', async () => {
  await run(false, 5);
  expect(events).toEqual(['answer 5 notSaved']);
});

test('a second stop while one is being saved is answered as not saved at once', async () => {
  let finish: ((value: { meeting_id: string }) => void) | undefined;
  saveMeeting = () => new Promise((resolve) => { finish = resolve; });
  let first!: Promise<void>;
  await act(async () => {
    first = stop(true, 1);
    await waitFor(() => finish !== undefined);
  });
  await act(async () => { await stop(true, 2); });
  expect(events).toEqual(['answer 2 notSaved']);
  await act(async () => {
    finish?.({ meeting_id: 'm1' });
    await first;
    await waitFor(() => timers === 0);
  });
  expect(events.slice(0, 3)).toEqual(['answer 2 notSaved', 'recovery record cleared', 'answer 1 saved']);
});

test('stops without a native stop id (error paths) send no answer', async () => {
  await run(false);
  expect(events.some((event) => event.startsWith('answer'))).toBe(false);
});

test('an answer that cannot be delivered does not break the save', async () => {
  answerFails = true;
  await reportSaveFinished(9, 'saved');
  await run(true, 7);
  expect(events).toEqual([
    'meeting saved',
    'recovery record cleared',
    'open /meeting-details?id=m1&source=recording',
    'clear transcripts',
  ]);
});
