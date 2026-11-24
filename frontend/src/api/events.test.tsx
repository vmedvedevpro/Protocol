import {renderHook} from '@testing-library/react'
import {describe, expect, it, vi} from 'vitest'
import {emitMockEvent} from '@/mocks/ipc'
import {mockState} from '@/mocks/state'
import {useNativeEvent} from './events'
import {UPDATER_STATUS_EVENT} from './updater'

// The mock IPC answers on microtasks, so one macrotask later listen() has
// registered (or, after an unmount, unregistered) its listener.
const settleIpc = () => new Promise((resolve) => setTimeout(resolve, 0))

/** What @tauri-apps/api hands to Tauri: the command, its arguments, its options. */
function spyOnIpc() {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (...call: unknown[]) => unknown } })
        .__TAURI_INTERNALS__
    return vi.spyOn(internals, 'invoke')
}

describe('native events', () => {
    it('stops listening on unmount, even before the listener finished registering', async () => {
        const handler = vi.fn()
        const {unmount} = renderHook(() => useNativeEvent(UPDATER_STATUS_EVENT, handler))
        unmount()
        await settleIpc()

        await emitMockEvent(UPDATER_STATUS_EVENT, mockState.updater)

        expect(handler).not.toHaveBeenCalled()
    })

    it('listens for one window when given its label', () => {
        const ipc = spyOnIpc()

        renderHook(() => useNativeEvent(UPDATER_STATUS_EVENT, () => {}, {target: 'main'}))

        expect(ipc).toHaveBeenCalledWith(
            'plugin:event|listen',
            expect.objectContaining({event: UPDATER_STATUS_EVENT, target: {kind: 'AnyLabel', label: 'main'}}),
            undefined,
        )
    })
})
