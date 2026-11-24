import {emit} from '@tauri-apps/api/event'
import {mockIPC, mockWindows} from '@tauri-apps/api/mocks'
import type {NativeEvent} from '@/api/events'
import {startMockRecordingLevels} from './audio'
import {handlers, type MockArgs, platformHandlers} from './handlers'
import {mockState, type MockState} from './state'

// `handlers` answers first, so a platform-only command left there too would
// answer on every platform.
for (const own of Object.values(platformHandlers)) {
    for (const command of Object.keys(own)) {
        if (Object.hasOwn(handlers, command)) {
            throw new Error(
                `"${command}" is in both handlers and platformHandlers in src/mocks/handlers.ts; keep it in platformHandlers only`,
            )
        }
    }
}

function handle(command: string, args: unknown): unknown {
    const handler = handlers[command] ?? platformHandlers[mockState.platform][command]
    if (handler) return handler((args ?? {}) as MockArgs)
    // Registered on another platform only: here native has no such command.
    if (Object.values(platformHandlers).some((own) => Object.hasOwn(own, command))) {
        throw `Command ${command} not found`
    }
    // Loud on purpose: a screen that calls a command nobody mocked fails here,
    // not with an empty reply that looks like real data.
    throw new Error(`The mock IPC has no handler for "${command}"; add one in src/mocks/handlers.ts`)
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
    // Keeps the ring and the meters moving in pnpm dev and Storybook; tests
    // emit the samples they need.
    if (import.meta.env.MODE !== 'test') startMockRecordingLevels()
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
