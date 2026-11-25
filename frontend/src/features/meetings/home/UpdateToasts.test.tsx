import {QueryClientProvider} from '@tanstack/react-query'
import {act, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {describe, expect, it} from 'vitest'
import {type UpdaterSnapshot, updaterStatusQuery} from '@/api/updater'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'
import {SEEN_KEY} from '../lib/updates'
import {UpdateToasts} from './UpdateToasts'

const offer = (downloaded: boolean): UpdaterSnapshot['offer'] => ({
    release: {version: '0.9.0', notes: null, date: null},
    downloaded,
    manualOnly: false,
    waitingForRecording: false,
})

function renderToasts(snapshot: Partial<UpdaterSnapshot>) {
    mockState.updater = {...mockState.updater, support: {kind: 'updatable', install: 'nsis'}, ...snapshot}
    const client = createTestQueryClient()
    const router = createMemoryRouter([
        {path: '/', element: <UpdateToasts/>},
        {path: '/settings', element: <p>Settings</p>},
    ])
    renderUi(<QueryClientProvider client={client}><RouterProvider router={router}/></QueryClientProvider>)
    /** What App's updater sync does when native says the status changed. */
    const push = (next: Partial<UpdaterSnapshot>) => act(() => {
        client.setQueryData(updaterStatusQuery.queryKey, (old) => old && {...old, ...next})
    })
    return {router, push}
}

describe('UpdateToasts', () => {
    it('announces a release once per version, with a way to Settings › Updates', async () => {
        const {router} = renderToasts({offer: offer(false)})
        expect(await screen.findByText('Protocol 0.9.0 is available')).toBeInTheDocument()
        expect(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')).toEqual({'available:0.9.0': true})

        await userEvent.click(screen.getByRole('button', {name: 'Details'}))
        expect(router.state.location).toMatchObject({pathname: '/settings'})
    })

    it('shows nothing for a version it already announced', async () => {
        localStorage.setItem(SEEN_KEY, JSON.stringify({'available:0.9.0': true}))
        renderToasts({offer: offer(false)})
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
        expect(screen.queryByText('Protocol 0.9.0 is available')).not.toBeInTheDocument()
    })

    it('says a download finished in this session is ready, but not one restored at launch', async () => {
        const {push} = renderToasts({offer: offer(false)})
        await screen.findByText('Protocol 0.9.0 is available')
        push({offer: offer(true)})
        expect(await screen.findByText('Protocol 0.9.0 is ready to install')).toBeInTheDocument()
    })

    it('keeps quiet about a download that was already there when the window opened', async () => {
        renderToasts({offer: offer(true)})
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
        expect(screen.queryByText(/ready to install/)).not.toBeInTheDocument()
    })

    it('waits while a recording runs', async () => {
        const {push} = renderToasts({offer: offer(false), busyReasons: ['recording']})
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)))
        expect(screen.queryByText('Protocol 0.9.0 is available')).not.toBeInTheDocument()
        push({busyReasons: []})
        expect(await screen.findByText('Protocol 0.9.0 is available')).toBeInTheDocument()
    })

    it('says the app was updated, with what is new', async () => {
        renderToasts({updatedFrom: '0.8.0', currentVersion: '0.9.0'})
        expect(await screen.findByText('Updated to Protocol 0.9.0')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'What’s new'}))
        expect(mockState.openedUrls).toEqual([expect.stringContaining('0.9.0')])
    })
})
