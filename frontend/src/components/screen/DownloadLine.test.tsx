import {QueryClientProvider} from '@tanstack/react-query'
import {act, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {describe, expect, it} from 'vitest'
import {downloadKey, type Downloads, downloadsQuery, PARAKEET_MODEL} from '@/api/models'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'
import {DownloadLineContext} from './downloadLine'
import {Screen} from './Screen'

function renderLine(shown = true) {
    const client = createTestQueryClient()
    const router = createMemoryRouter([
        {path: '/', element: <Screen><h1>Meetings</h1></Screen>},
        {path: '/settings/:page', element: <h1>Speech models</h1>},
    ])
    renderUi(
        <QueryClientProvider client={client}>
            <DownloadLineContext value={shown}><RouterProvider router={router}/></DownloadLineContext>
        </QueryClientProvider>,
    )
    const set = (downloads: Downloads) =>
        act(() => void client.setQueryData(downloadsQuery.queryKey, downloads))
    return {router, set}
}

describe('DownloadLine', () => {
    it('says what downloads below 100 % until it is verified, and opens Speech models', async () => {
        const {router, set} = renderLine()
        expect(screen.queryByRole('button', {name: /Downloading/})).not.toBeInTheDocument()

        set({[downloadKey('parakeet', PARAKEET_MODEL)]: {state: 'downloading', progress: 100}})
        const line = await screen.findByRole('button', {name: /Downloading Parakeet/})
        expect(line).toHaveTextContent('99%')

        await userEvent.click(line)
        expect(router.state.location.pathname).toBe('/settings/speech-models')
    })

    it('counts several downloads and leaves failed ones to their rows', async () => {
        const {set} = renderLine()
        set({
            [downloadKey('parakeet', PARAKEET_MODEL)]: {state: 'downloading', progress: 20},
            [downloadKey('nemotron', 'nemotron')]: {state: 'downloading', progress: 40},
            [downloadKey('whisper', 'small')]: {state: 'failed', error: 'Network'},
        })
        expect(await screen.findByRole('button', {name: /Downloading 2 models/})).toHaveTextContent('30%')
    })

    it('is not there where the shell does not offer it, as on first launch', () => {
        const {set} = renderLine(false)
        set({[downloadKey('parakeet', PARAKEET_MODEL)]: {state: 'downloading', progress: 20}})
        expect(screen.queryByRole('button', {name: /Downloading/})).not.toBeInTheDocument()
    })
})
