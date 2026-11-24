import type {ReactNode} from 'react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {renderHook} from '@testing-library/react'
import {describe, expect, it, vi} from 'vitest'
import {useNativeEvent} from '@/api/events'
import {UPDATER_STATUS_EVENT, type UpdaterSnapshot, updaterStatusQuery} from '@/api/updater'
import {emitMockEvent} from '@/mocks/ipc'
import {mockState} from '@/mocks/state'
import {useUpdaterStatusSync} from './useUpdaterStatusSync'

function wrapperWith(queryClient: QueryClient) {
    return function Wrapper({children}: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

// The mock IPC answers on microtasks, so one macrotask later listen() has
// registered (or, after an unmount, unregistered) its listener.
const settleIpc = () => new Promise((resolve) => setTimeout(resolve, 0))

const readySnapshot = (): UpdaterSnapshot => ({
    ...mockState.updater,
    support: {kind: 'updatable', install: 'nsis'},
    offer: {
        release: {version: '0.7.0', notes: null, date: null},
        downloaded: true,
        manualOnly: false,
        waitingForRecording: false,
    },
})

describe('updater-status', () => {
    it('replaces the cached snapshot with the one the event carries', async () => {
        const queryClient = new QueryClient()
        await queryClient.fetchQuery(updaterStatusQuery)
        renderHook(() => useUpdaterStatusSync(), {wrapper: wrapperWith(queryClient)})
        await settleIpc()

        const snapshot = readySnapshot()
        await emitMockEvent(UPDATER_STATUS_EVENT, snapshot)

        expect(queryClient.getQueryData(updaterStatusQuery.queryKey)).toEqual(snapshot)
    })

    it('stops listening on unmount, even before the listener finished registering', async () => {
        const handler = vi.fn()
        const {unmount} = renderHook(() => useNativeEvent(UPDATER_STATUS_EVENT, handler))
        unmount()
        await settleIpc()

        await emitMockEvent(UPDATER_STATUS_EVENT, readySnapshot())

        expect(handler).not.toHaveBeenCalled()
    })
})
