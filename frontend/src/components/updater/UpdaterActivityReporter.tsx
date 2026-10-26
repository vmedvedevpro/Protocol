'use client';

import { useEffect } from 'react';
import { RecordingStatus, useRecordingState } from '@/contexts/RecordingStateContext';
import { currentUiActivity, markUiActivity, onUiActivity, reportUiActivity, type UiActivity } from '@/lib/updater';

/** How often a non-empty set is reported again; native code drops it after 150 s. */
export const RENEW_MS = 60_000;

const SAVING = new Set([RecordingStatus.STOPPING, RecordingStatus.PROCESSING_TRANSCRIPTS, RecordingStatus.SAVING]);

const send = (activities: UiActivity[]) => {
  reportUiActivity(activities).catch(() => undefined);
};

/**
 * Tells the native updater about work only the WebView sees: saving a meeting
 * after its recording stopped, and the post-call pipeline (marked by
 * PostCallJobsProvider). It only reports; the native install gate decides.
 */
export function UpdaterActivityReporter() {
  const { status } = useRecordingState();
  const saving = SAVING.has(status);

  useEffect(() => {
    markUiActivity('recordingSave', saving);
  }, [saving]);

  useEffect(() => {
    send(currentUiActivity());
    const stop = onUiActivity(send);
    const timer = window.setInterval(() => {
      const activities = currentUiActivity();
      if (activities.length) send(activities);
    }, RENEW_MS);
    return () => {
      stop();
      window.clearInterval(timer);
      markUiActivity('recordingSave', false);
      send([]);
    };
  }, []);

  return null;
}
