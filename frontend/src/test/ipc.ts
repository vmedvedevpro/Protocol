import {vi} from 'vitest'

/**
 * The mock IPC answers on microtasks, so one macrotask later listen() has
 * registered (or unregistered) its listener and an event's handler has
 * finished.
 */
export const settleIpc = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Spies on what @tauri-apps/api hands to Tauri: the command, its arguments, its options. */
export function spyOnIpc() {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (...call: unknown[]) => unknown } })
        .__TAURI_INTERNALS__
    return vi.spyOn(internals, 'invoke')
}
