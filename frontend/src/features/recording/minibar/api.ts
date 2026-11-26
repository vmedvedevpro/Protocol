/**
 * The minibar's own native calls (src-tauri/src/minibar.rs). Pause, resume,
 * the mutes and the recording's state go through ../api/recording, as the
 * main window's do.
 */
import {getCurrentWindow} from '@tauri-apps/api/window'
import {command} from '@/api/core'
import type {NativeEvent} from '@/api/events'

/**
 * The pointer left the minibar's window (Linux only, keep_above.rs).
 * WebKitGTK fires no pointerleave when the pointer leaves the whole view on
 * Wayland, and the window is exactly the pill, so this closes it instead.
 */
export const MINIBAR_POINTER_LEFT_EVENT = 'minibar-pointer-left' as NativeEvent<null>

/**
 * Hides the main window and shows the minibar. `elapsedSeconds` marks an
 * explicit shrink (native then focuses the bar); the bar reads its timer from
 * native whatever is sent. Minimizing during a recording opens it natively.
 */
export const enterCompactMode = (elapsedSeconds: number) => command<null>('enter_compact_mode', {elapsedSeconds})

/** Closes the minibar and brings the main window back. */
export const exitCompactMode = () => command<null>('exit_compact_mode')

/**
 * Fits the window to the pill, `width` CSS pixels wide, so no transparent
 * part of it takes clicks meant for the windows below. Native keeps the
 * window's left edge and its monitor.
 */
export const resizeMinibar = (width: number) => command<null>('resize_minibar', {width})

/**
 * Stops the recording from the minibar. Native hides the bar and restores
 * the main window as the stop begins, and the main window saves the meeting
 * on `recording-stop-complete`, as after any other Stop (save.ts). Resolves
 * once native has finished stopping.
 */
export const stopRecordingFromMinibar = () => command<boolean>('stop_recording_from_minibar')

/**
 * Moves the window with the pointer until the button is released. Async so
 * that getCurrentWindow(), which throws outside Tauri, rejects instead; the
 * `minibar-drag` capability in tauri.conf.json allows it.
 */
export async function startWindowDragging(): Promise<void> {
    await getCurrentWindow().startDragging()
}
