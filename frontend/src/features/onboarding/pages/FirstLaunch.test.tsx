import {QueryClientProvider} from '@tanstack/react-query'
import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {describe, expect, it, vi} from 'vitest'
import {useModelDownloadSync} from '@/api/modelDownloadSync'
import {downloadKey, PARAKEET_MODEL, POST_CALL_WHISPER_MODEL} from '@/api/models'
import {onboardingStatusQuery} from '@/api/onboarding'
import {MEETING_LANGUAGE_KEY, USER_NAME_KEY, usePreferencesSync} from '@/api/preferences'
import {TYPING_SETTLE_MS} from '@/components/summaryModel/draft'
import {handlers} from '@/mocks/handlers'
import {GPU_VERSION_ID} from '@/mocks/intel'
import {createMockModels} from '@/mocks/models'
import {completedOnboarding} from '@/mocks/onboarding'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'
import {FirstLaunch} from './FirstLaunch'

// Three fake downloads of two ticks each, 250 ms apart, with room to spare.
const DOWNLOADS_MS = 4000

// What the app and the shell mount in front of first launch: the
// preferences native is sent, and the download events.
function DownloadSync() {
    usePreferencesSync()
    useModelDownloadSync()
    return null
}

/** First launch as the shell shows it: once the gate has read the status. */
async function renderFirstLaunch() {
    const client = createTestQueryClient()
    await client.prefetchQuery(onboardingStatusQuery)
    const router = createMemoryRouter([{path: '/', element: <><DownloadSync/><FirstLaunch platform="linux"/></>}])
    const result = renderUi(<QueryClientProvider client={client}><RouterProvider router={router}/></QueryClientProvider>)
    return {client, ...result}
}

/** Whether the status Done invalidated has been read again as completed. */
const statusReadAgain = (client: Awaited<ReturnType<typeof renderFirstLaunch>>['client']) =>
    waitFor(() => expect(client.getQueryData(onboardingStatusQuery.queryKey)?.completed).toBe(true))

/** A new install: no first launch saved, no models, no summary model. */
function newInstall() {
    mockState.onboarding = null
    mockState.models = createMockModels({fresh: true})
    mockState.models.downloadStep = 50
    mockState.preferences.summaryModel = null
}

/** Back after a restart on the second step. */
function onSecondStep() {
    mockState.onboarding = {...completedOnboarding(), completed: false, current_step: 2}
}

// The footer says the same as the toast; only the toast is a notification.
const notification = (text: string) => within(screen.getByRole('region', {name: /Notifications/})).queryByText(text)
const heading = (name: string) => screen.findByRole('heading', {level: 1, name})
const row = (title: string) => within(screen.getByText(title).closest('li') as HTMLElement)
const ready = (title: string) => waitFor(() => expect(row(title).getByText('Ready')).toBeInTheDocument(), {timeout: DOWNLOADS_MS})
const done = () => screen.getByRole('button', {name: 'Done'})

describe('First launch', () => {
    it('asks the name, downloads the speech models one after another, and Done completes first launch', async () => {
        newInstall()
        const builtIn = vi.spyOn(handlers, 'builtin_ai_download_model')
        const {client} = await renderFirstLaunch()

        await heading('Welcome to Protocol')
        await userEvent.type(screen.getByRole('textbox', {name: 'What should we call you?'}), 'Ada{Enter}')
        expect(localStorage.getItem(USER_NAME_KEY)).toBe('Ada')

        expect(await heading('Get ready for the first meeting')).toHaveFocus()
        expect(mockState.onboarding?.current_step).toBe(2)
        // Parakeet first; the others wait their turn.
        await waitFor(() => expect(row('Live text').getByText('50%')).toBeInTheDocument())
        expect(row('Transcript after meetings').getByText('Queued')).toBeInTheDocument()
        await ready('Live text')
        await ready('Transcript after meetings')
        // Native made Whisper the after-meeting model once it was verified.
        expect(mockState.speech.postCallConfig).toEqual({provider: 'whisper', model: POST_CALL_WHISPER_MODEL})

        // Summaries are left for later unless the user chooses: nothing downloads for them.
        expect(screen.getByRole('radio', {name: /Later/})).toBeChecked()
        await userEvent.click(done())

        await statusReadAgain(client)
        expect(mockState.onboarding).toMatchObject({completed: true, model_status: {parakeet: 'downloaded', summary: 'not_downloaded'}})
        expect(mockState.onboarding?.model_status.selected_summary_provider).toBeUndefined()
        expect(mockState.preferences.summaryModel).toBeNull()
        expect(builtIn).not.toHaveBeenCalled()
        expect(notification('Downloads continue in the background')).not.toBeInTheDocument()
    }, 10_000)

    it('installs the built-in summary model only on Install, with Cancel, and Done selects it', async () => {
        newInstall()
        onSecondStep()
        mockState.models.downloadStep = 25
        const {client} = await renderFirstLaunch()
        await heading('Get ready for the first meeting')

        await userEvent.click(screen.getByRole('radio', {name: /On this computer/}))
        expect(done()).toBeDisabled()
        expect(screen.getByText('Install the model, or choose Later')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Install Qwen 3.5 4B'}))
        expect(screen.getByRole('button', {name: 'Install Qwen 3.5 4B'})).toHaveTextContent('Install (2.6 GB)')

        // Cancel takes it back to Install, and nothing is chosen.
        await userEvent.click(await screen.findByRole('button', {name: 'Cancel downloading Qwen 3.5 4B'}))
        await userEvent.click(await screen.findByRole('button', {name: 'Install Qwen 3.5 4B'}))
        await screen.findByRole('button', {name: 'Cancel downloading Qwen 3.5 4B'})
        expect(done()).toBeEnabled()

        await userEvent.click(done())

        await statusReadAgain(client)
        expect(mockState.preferences.summaryModel).toMatchObject({provider: 'builtin-ai', model: 'qwen3.5:4b'})
        expect(mockState.onboarding?.model_status).toMatchObject({selected_summary_provider: 'builtin-ai', selected_summary_model: 'qwen3.5:4b'})
        expect(notification('Downloads continue in the background')).toBeInTheDocument()
    }, 10_000)

    it('saves a provider with the user’s key as Settings does, keeping the key out of every query key', async () => {
        newInstall()
        onSecondStep()
        const {client} = await renderFirstLaunch()
        await heading('Get ready for the first meeting')

        await userEvent.click(screen.getByRole('radio', {name: /With your API key/}))
        expect(done()).toBeDisabled()
        await userEvent.click(screen.getByRole('combobox', {name: 'Provider'}))
        await userEvent.click(await screen.findByRole('option', {name: 'Claude'}))
        // The list blocks the page's pointer until it has closed.
        await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
        await userEvent.type(await screen.findByLabelText('API key'), 'sk-ant-first')
        expect(done()).toBeDisabled()
        expect(screen.getByText('Paste a key and pick a model')).toBeInTheDocument()
        // The list is asked once typing the key has rested.
        await waitFor(() => expect(screen.getByRole('combobox', {name: 'Model'})).toBeEnabled(), {timeout: TYPING_SETTLE_MS + 2_000})
        await userEvent.click(screen.getByRole('combobox', {name: 'Model'}))
        await userEvent.click(await screen.findByRole('option', {name: 'Claude Sonnet 4.5'}))
        await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())

        await userEvent.click(done())

        await statusReadAgain(client)
        expect(mockState.preferences.summaryModel).toMatchObject({provider: 'claude', model: 'claude-sonnet-4-5-20250929'})
        expect(mockState.preferences.apiKeys.claude).toBe('sk-ant-first')
        expect(mockState.onboarding?.model_status).toMatchObject({selected_summary_provider: 'claude', summary: 'downloaded'})
        const keys = client.getQueryCache().getAll().map(({queryKey}) => JSON.stringify(queryKey))
        expect(keys.some((key) => key.includes('sk-ant-first'))).toBe(false)
    }, 10_000)

    describe('the meeting language', () => {
        const language = () => screen.getByRole('combobox', {name: 'Meeting language'})

        async function secondStep(locale: string) {
            vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale)
            newInstall()
            onSecondStep()
            const result = await renderFirstLaunch()
            await heading('Get ready for the first meeting')
            return result
        }

        it('comes preselected with the system’s language when Whisper lists it', async () => {
            await secondStep('ru-RU')
            expect(language()).toHaveTextContent('Russian')
        })

        it('is English on an English system', async () => {
            await secondStep('en-US')
            expect(language()).toHaveTextContent('English')
        })

        it('detects a language Whisper doesn’t list', async () => {
            await secondStep('fil-PH')
            expect(language()).toHaveTextContent('Detect automatically')
        })

        it('is saved on Done and sent to native as Settings does', async () => {
            const {client} = await secondStep('ru-RU')
            await userEvent.click(language())
            await userEvent.click(await screen.findByRole('option', {name: 'German'}))
            await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
            // Nothing is stored before Done.
            expect(localStorage.getItem(MEETING_LANGUAGE_KEY)).toBeNull()

            await userEvent.click(done())
            await statusReadAgain(client)
            expect(localStorage.getItem(MEETING_LANGUAGE_KEY)).toBe('de')
            await waitFor(() => expect(mockState.preferences.languagePreference).toBe('de'))
        })
    })

    it('downloads Whisper’s Intel GPU version on an Intel GPU, which native makes the after-meeting model', async () => {
        newInstall()
        mockState.platform = 'windows'
        mockState.intel.gpu = true
        mockState.intel.downloadStep = 50
        await renderFirstLaunch()
        await heading('Welcome to Protocol')
        await userEvent.type(screen.getByRole('textbox', {name: 'What should we call you?'}), 'Ada{Enter}')

        expect(await screen.findByText('Whisper Large V3 Turbo on the Intel GPU')).toBeInTheDocument()
        await ready('Transcript after meetings')

        expect(mockState.speech.postCallConfig).toEqual({provider: 'whisper', model: GPU_VERSION_ID})
        expect(mockState.models.whisper[POST_CALL_WHISPER_MODEL]).toBe('Missing')
    }, 10_000)

    it('downloads Intel’s libraries for Parakeet on an Intel NPU', async () => {
        newInstall()
        mockState.platform = 'windows'
        mockState.intel.npu = true
        mockState.intel.downloadStep = 50
        await renderFirstLaunch()
        await heading('Welcome to Protocol')
        await userEvent.type(screen.getByRole('textbox', {name: 'What should we call you?'}), 'Ada{Enter}')

        expect(await screen.findByText('Parakeet on the Intel NPU')).toBeInTheDocument()
        await ready('Live text on the Intel NPU')
        expect(mockState.intel.runtimeInstalled).toBe(true)
    }, 10_000)

    it('goes on after a failed download, and Retry downloads it again', async () => {
        newInstall()
        onSecondStep()
        mockState.models.failing = [downloadKey('parakeet', PARAKEET_MODEL)]
        await renderFirstLaunch()

        await heading('Get ready for the first meeting')
        const retry = await screen.findByRole('button', {name: 'Retry Live text'}, {timeout: DOWNLOADS_MS})
        expect(row('Live text').getByText(/connection reset/)).toBeInTheDocument()
        await ready('Transcript after meetings')

        await userEvent.click(retry)

        await ready('Live text')
    }, 10_000)

    it('completes before the downloads end, which go on after the screen and say so', async () => {
        newInstall()
        onSecondStep()
        const {client, unmount} = await renderFirstLaunch()
        await heading('Get ready for the first meeting')
        await waitFor(() => expect(row('Live text').getByText('50%')).toBeInTheDocument())

        await userEvent.click(screen.getByRole('button', {name: 'Done'}))

        await statusReadAgain(client)
        expect(notification('Downloads continue in the background')).toBeInTheDocument()
        expect(mockState.onboarding?.model_status).toMatchObject({parakeet: 'not_downloaded', summary: 'not_downloaded'})
        // The gate swaps first launch for the app; the run goes on.
        unmount()
        await waitFor(() => expect(mockState.models.whisper[POST_CALL_WHISPER_MODEL]).toBe('Available'), {timeout: DOWNLOADS_MS})
    }, 10_000)

    it('downloads nothing that is installed already', async () => {
        onSecondStep()
        const downloads = ['parakeet_download_model', 'whisper_download_model']
            .map((command) => vi.spyOn(handlers, command))
        await renderFirstLaunch()

        await heading('Get ready for the first meeting')
        await ready('Live text')
        await ready('Transcript after meetings')
        for (const download of downloads) expect(download).not.toHaveBeenCalled()
    })

    it('goes back to the name', async () => {
        onSecondStep()
        await renderFirstLaunch()
        await heading('Get ready for the first meeting')

        await userEvent.click(screen.getByRole('button', {name: 'Back'}))

        await heading('Welcome to Protocol')
        expect(screen.getByRole('textbox', {name: 'What should we call you?'})).toHaveFocus()
        expect(screen.getByText('Step 1 of 2')).toBeInTheDocument()
        expect(mockState.onboarding?.current_step).toBe(1)
    })
})
