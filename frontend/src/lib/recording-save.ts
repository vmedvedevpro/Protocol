import { invoke } from '@tauri-apps/api/core';

/** How the save after a native Stop ended (src-tauri/src/audio/save_handoff.rs). */
export type SaveOutcome = 'saved' | 'discarded' | 'notSaved' | 'failed';

/**
 * Answers the Stop that handed this meeting over (`stop_id` in
 * `recording-stop-complete`). A quit during a recording waits for this answer
 * before Protocol exits. Resolves true when Protocol quits once the save is
 * done: the caller then does not open the meeting, so no post-call processing
 * starts that the exit would cut off.
 */
export async function reportSaveFinished(stopId: number | undefined, outcome: SaveOutcome): Promise<boolean> {
  if (stopId === undefined) return false;
  try {
    return await invoke<boolean>('recording_save_finished', { stopId, outcome });
  } catch (error) {
    console.warn('Could not report the end of the meeting save:', error);
    return false;
  }
}
