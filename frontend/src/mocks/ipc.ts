import {emit} from '@tauri-apps/api/event'
import {mockIPC, mockWindows} from '@tauri-apps/api/mocks'
import type {NativeEvent} from '@/api/events'
import {handlers, type MockArgs} from './handlers'
import {mockState, type MockState} from './state'

function handle(command: string, args: unknown): unknown {
    const handler = handlers[command]
    // Loud on purpose: a screen that calls a command nobody mocked fails here,
    // not with an empty reply that looks like real data.
    if (!handler) throw new Error(`The mock IPC has no handler for "${command}"; add one in src/mocks/handlers.ts`)
    return handler((args ?? {}) as MockArgs)
}

/**
 * Sends every Tauri command and event of this page to the in-memory mock.
 * Runs before anything calls @tauri-apps/api: in main.tsx outside Tauri in
 * development, in Storybook, and before each test.
 */
export function installMockIpc() {
    // Window commands act on the current window's label; minibar.rs opens
    // /minibar in a window labelled `minibar`.
    mockWindows(window.location.pathname.startsWith('/minibar') ? 'minibar' : 'main')
    mockIPC(handle, {shouldMockEvents: true})
    if (import.meta.env.DEV) window.__PROTOCOL_MOCK__ = {emit: emitMockEvent, state: mockState}
}

/** Delivers a native event to the page's listeners, as `app.emit` in Rust does. */
export function emitMockEvent<T>(event: NativeEvent<T>, payload: T): Promise<void> {
    return emit(event, payload)
}

declare global {
    interface Window {
        /**
         * The mock from the devtools console, in development only:
         * `__PROTOCOL_MOCK__.emit('updater-status', {...})`.
         */
        __PROTOCOL_MOCK__?: {
            emit: typeof emitMockEvent
            state: MockState
        }
    }
}
