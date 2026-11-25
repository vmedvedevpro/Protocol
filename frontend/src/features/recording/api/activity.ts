/**
 * Work only the WebView does, reported to the updater so that an update
 * never restarts the app in the middle of it (src-tauri/src/updater/busy.rs,
 * docs/UI_ARCHITECTURE.md › Native data). Native drops a report after
 * `UI_LEASE` (150 s), so it is renewed while the work lasts; an unknown
 * name rejects the whole call, so a new activity needs a native
 * `UiActivity` variant first.
 *
 * - `recordingSave`: after Stop, the wait for the last lines and the save;
 *   and a recovery's audio rebuild and save.
 * - `postCall`: a post-call pass is queued, runs or waits on a failure.
 */
import {command} from '@/api/core'

export type UiActivity = 'recordingSave' | 'postCall'

/** Replaces the WebView's set of activities; `[]` when nothing runs. */
export const setUiActivity = (activities: readonly UiActivity[]) =>
    command<null>('updater_set_ui_activity', {activities})

/** How often a non-empty set is sent again: well inside native's 150 s lease. */
export const UI_ACTIVITY_RENEW_MS = 60_000
