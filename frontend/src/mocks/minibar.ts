import type {MockArgs, MockHandler} from './handlers'
import {liveHandlers} from './live'
import type {MockState} from './state'

/** The minibar window as native keeps it (src-tauri/src/minibar.rs). */
export function createMockMinibar() {
    return {
        /** Shown, with the main window hidden. */
        open: false,
        /** `elapsedSeconds` of every `enter_compact_mode`, in order. */
        entered: [] as (number | null)[],
        /** Presses that moved the window (`startDragging`). */
        drags: 0,
        /** The window's width from the last `resize_minibar`, null before one. */
        width: null as number | null,
    }
}

export type MockMinibar = ReturnType<typeof createMockMinibar>

/** minibar.rs, and the window plugin's drag. */
export function minibarHandlers(state: MockState): Record<string, MockHandler> {
    const live = liveHandlers(state)
    return {
        enter_compact_mode: ({elapsedSeconds}: MockArgs) => {
            // Native rechecks under its lock: no recording, no bar.
            if (!state.live.recording) return null
            state.minibar.open = true
            state.minibar.entered.push(typeof elapsedSeconds === 'number' ? elapsedSeconds : null)
            return null
        },
        // Native clamps it between the pill's height and MINIBAR_WIDTH.
        resize_minibar: ({width}: MockArgs) => {
            state.minibar.width = Math.min(Math.max(Number(width), 52), 512)
            return null
        },
        exit_compact_mode: () => {
            state.minibar.open = false
            return null
        },
        // Native's Stop from the bar: the bar goes, the main window saves (live.ts).
        stop_recording_from_minibar: () => {
            state.minibar.open = false
            return live.stop_recording({args: {save_path: '/home/user/.local/share/protocol/recording.wav'}})
        },
        'plugin:window|start_dragging': () => {
            state.minibar.drags += 1
            return null
        },
    }
}
