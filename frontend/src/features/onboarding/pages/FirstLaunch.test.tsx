import {QueryClientProvider} from '@tanstack/react-query'
import {render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {downloadKey, PARAKEET_MODEL, POST_CALL_WHISPER_MODEL} from '@/api/models'
import {USER_NAME_KEY} from '@/api/preferences'
import {App} from '@/app/App'
import {handlers} from '@/mocks/handlers'
import {createMockModels} from '@/mocks/models'
import {completedOnboarding} from '@/mocks/onboarding'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'

// Three fake downloads of two ticks each, 250 ms apart, with room to spare.
const DOWNLOADS_MS = 4000

function renderApp() {
    window.history.replaceState(null, '', '/')
    return render(
        <QueryClientProvider client={createTestQueryClient()}>
            <App/>
        </QueryClientProvider>,
    )
}

/** A new install: no database, no first launch saved, no models. */
function newInstall() {
    mockState.database.exists = false
    mockState.onboarding = null
    mockState.models = createMockModels({fresh: true})
    mockState.models.downloadStep = 50
}

/** Back after a restart on the second step. */
function onSecondStep() {
    mockState.onboarding = {...completedOnboarding(), completed: false, current_step: 2}
}

const heading = (name: string) => screen.findByRole('heading', {level: 1, name})
const row = (title: string) => within(screen.getByText(title).closest('li') as HTMLElement)
const ready = (title: string) => waitFor(() => expect(row(title).getByText('Ready')).toBeInTheDocument(), {timeout: DOWNLOADS_MS})

describe('First launch', () => {
    it('asks the name, downloads the models one after another, and Done opens the app', async () => {
        newInstall()
        renderApp()

        await heading('Welcome to Protocol')
        expect(mockState.database.setUps).toEqual(['fresh'])
        await userEvent.type(screen.getByRole('textbox', {name: 'What should we call you?'}), 'Ada{Enter}')
        expect(localStorage.getItem(USER_NAME_KEY)).toBe('Ada')

        expect(await heading('Get ready for the first meeting')).toHaveFocus()
        expect(mockState.onboarding?.current_step).toBe(2)
        // Parakeet first; the others wait their turn.
        await waitFor(() => expect(row('Live text').getByText('50%')).toBeInTheDocument())
        expect(row('Transcript after meetings').getByText('Queued')).toBeInTheDocument()
        expect(row('Summaries').getByText('Queued')).toBeInTheDocument()
        await ready('Live text')
        await ready('Transcript after meetings')
        await ready('Summaries')
        // Native made Whisper the after-meeting model once it was verified.
        expect(mockState.models.postCallModel).toBe(POST_CALL_WHISPER_MODEL)

        await userEvent.click(screen.getByRole('button', {name: 'Done'}))

        await heading('Meetings')
        expect(mockState.onboarding).toMatchObject({
            completed: true,
            model_status: {parakeet: 'downloaded', summary: 'downloaded', selected_summary_model: 'qwen3.5:4b'},
        })
        expect(screen.queryByText('Downloads continue in the background')).not.toBeInTheDocument()
    }, 10_000)

    it('goes on after a failed download, and Retry downloads it again', async () => {
        newInstall()
        onSecondStep()
        mockState.models.failing = [downloadKey('parakeet', PARAKEET_MODEL)]
        renderApp()

        await heading('Get ready for the first meeting')
        const retry = await screen.findByRole('button', {name: 'Retry Live text'}, {timeout: DOWNLOADS_MS})
        expect(row('Live text').getByText(/connection reset/)).toBeInTheDocument()
        await ready('Transcript after meetings')
        await ready('Summaries')

        await userEvent.click(retry)

        await ready('Live text')
    }, 10_000)

    it('lets the app in before the downloads end, which go on and say so', async () => {
        newInstall()
        onSecondStep()
        renderApp()
        await heading('Get ready for the first meeting')
        await waitFor(() => expect(row('Live text').getByText('50%')).toBeInTheDocument())

        await userEvent.click(screen.getByRole('button', {name: 'Done'}))

        await heading('Meetings')
        expect(screen.getByText('Downloads continue in the background')).toBeInTheDocument()
        expect(mockState.onboarding?.model_status).toMatchObject({parakeet: 'not_downloaded', summary: 'not_downloaded'})
        await waitFor(() => expect(mockState.models.builtIn['qwen3.5:4b']).toEqual({type: 'available'}), {timeout: DOWNLOADS_MS})
    }, 10_000)

    it('downloads nothing that is installed already', async () => {
        onSecondStep()
        const downloads = ['parakeet_download_model', 'whisper_download_model', 'builtin_ai_download_model']
            .map((command) => vi.spyOn(handlers, command))
        renderApp()

        await heading('Get ready for the first meeting')
        await ready('Live text')
        await ready('Transcript after meetings')
        await ready('Summaries')
        for (const download of downloads) expect(download).not.toHaveBeenCalled()
    })

    it('goes back to the name', async () => {
        onSecondStep()
        renderApp()
        await heading('Get ready for the first meeting')

        await userEvent.click(screen.getByRole('button', {name: 'Back'}))

        await heading('Welcome to Protocol')
        expect(screen.getByRole('textbox', {name: 'What should we call you?'})).toHaveFocus()
        expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
        expect(mockState.onboarding?.current_step).toBe(1)
    })
})
