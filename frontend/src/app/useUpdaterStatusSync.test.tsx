import type {ReactNode} from 'react'
import {type QueryClient, QueryClientProvider, useQuery} from '@tanstack/react-query'
import {renderHook, waitFor} from '@testing-library/react'
import {describe, expect, it, vi} from 'vitest'
import {UPDATER_STATUS_EVENT, type UpdaterSnapshot, updaterStatusQuery} from '@/api/updater'
import {handlers} from '@/mocks/handlers'
import {emitMockEvent} from '@/mocks/ipc'
import {mockState} from '@/mocks/state'
import {settleIpc} from '@/test/ipc'
import {createTestQueryClient} from '@/test/queryClient'
import {useUpdaterStatusSync} from './useUpdaterStatusSync'

function wrapperWith(queryClient: QueryClient) {
    return function Wrapper({children}: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    }
}

/** A screen that shows the status, under App's sync hook. */
function useStatusOnScreen() {
    useQuery(updaterStatusQuery)
    useUpdaterStatusSync()
}

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
        const queryClient = createTestQueryClient()
        await queryClient.fetchQuery(updaterStatusQuery)
        renderHook(() => useUpdaterStatusSync(), {wrapper: wrapperWith(queryClient)})
        await settleIpc()

        const snapshot = readySnapshot()
        await emitMockEvent(UPDATER_STATUS_EVENT, snapshot)
        await settleIpc()

        expect(queryClient.getQueryData(updaterStatusQuery.queryKey)).toEqual(snapshot)
    })

    it('keeps the event over a reply that was still in flight when it arrived', async () => {
        const before = mockState.updater
        let reply: (snapshot: UpdaterSnapshot) => void = () => {}
        vi.spyOn(handlers, 'updater_get_status').mockImplementation(
            () => new Promise<UpdaterSnapshot>((resolve) => (reply = resolve)),
        )
        const queryClient = createTestQueryClient()
        renderHook(() => useStatusOnScreen(), {wrapper: wrapperWith(queryClient)})
        await settleIpc()

        const snapshot = readySnapshot()
        await emitMockEvent(UPDATER_STATUS_EVENT, snapshot)
        // Native code answered the read before it sent the event, but the
        // reply reaches the webview after it.
        reply(before)
        await settleIpc()

        expect(queryClient.getQueryData(updaterStatusQuery.queryKey)).toEqual(snapshot)
    })

    it('reads the snapshot again once listening, so a change sent before that is not lost', async () => {
        const queryClient = createTestQueryClient()
        await queryClient.fetchQuery(updaterStatusQuery)
        // The snapshot changed before the listener existed; its event went nowhere.
        mockState.updater = readySnapshot()

        renderHook(() => useStatusOnScreen(), {wrapper: wrapperWith(queryClient)})

        await waitFor(() => expect(queryClient.getQueryData(updaterStatusQuery.queryKey)).toEqual(mockState.updater))
    })
})
