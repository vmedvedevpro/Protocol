import { invoke } from '@tauri-apps/api/core';

/** How the save after a native Stop ended (src-tauri/src/audio/save_handoff.rs). */
export type SaveOutcome = 'saved' | 'discarded' | 'notSaved' | 'failed';

/**
 * Answers the Stop that handed this meeting over (`stop_id` in
 * `recording-stop-complete`), so native code knows when the save has ended.
 */
export async function reportSaveFinished(stopId: number | undefined, outcome: SaveOutcome): Promise<void> {
  if (stopId === undefined) return;
  try {
    await invoke('recording_save_finished', { stopId, outcome });
  } catch (error) {
    console.warn('Could not report the end of the meeting save:', error);
  }
}
