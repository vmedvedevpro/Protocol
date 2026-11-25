import {createElement} from 'react'
import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {listBuiltInModels} from '@/api/models'
import {mockState} from '@/mocks/state'
import {PROVIDER_MODEL_MAP_KEY} from '@/api/summaryProviders'
import {SettingsPage} from '../../pages/SettingsPage'
import {indexedLabels} from '../../pages/settingsPages'
import {renderedRowLabels, renderSettings} from '../../testing'
import {shortModelName, SUMMARY_PROVIDERS} from '@/api/summaryProviders'

const open = () => renderSettings(createElement(SettingsPage), '/settings/summary-model')
const group = (name: string) => screen.getByRole('region', {name})
const save = () => screen.getByRole('button', {name: 'Save'})

describe('Summary model page', () => {
    it('starts at the saved provider and its model', async () => {
        open()
        const provider = await screen.findByRole('radiogroup', {name: 'Provider'})
        expect(within(provider).getByRole('radio', {name: /Built-in AI/})).toBeChecked()
        const models = group('Built-in models')
        expect(await within(models).findByText('In use')).toBeInTheDocument()
        expect(within(models).getByText(/Qwen 3.5 4B/)).toBeInTheDocument()
        expect(save()).toBeEnabled()
    })

    it('saves a cloud provider with its key and model', async () => {
        const {router} = open()
        await userEvent.click(await screen.findByRole('radio', {name: /Claude/}))
        expect(save()).toBeDisabled()

        await userEvent.type(screen.getByLabelText('API key'), 'sk-ant-test')
        await userEvent.click(screen.getByRole('combobox', {name: 'Model'}))
        await userEvent.click(await screen.findByRole('option', {name: 'Claude Sonnet 4.5'}))
        expect(screen.getByText('Meetings you summarize are sent to Claude.')).toBeInTheDocument()

        // The select's list hides the rest of the page until it has closed.
        await userEvent.click(await screen.findByRole('button', {name: 'Save'}))
        await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
        expect(mockState.preferences.summaryModel).toMatchObject({provider: 'claude', model: 'claude-sonnet-4-5-20250929', summaryMaxTokens: null})
        expect(mockState.preferences.apiKeys.claude).toBe('sk-ant-test')
    })

    it('picks the model the old settings saved for a provider switched to', async () => {
        localStorage.setItem(PROVIDER_MODEL_MAP_KEY, JSON.stringify({groq: 'gemma2-9b-it'}))
        open()
        await userEvent.click(await screen.findByRole('radio', {name: /Groq/}))
        expect(await screen.findByRole('combobox', {name: 'Model'})).toHaveTextContent('gemma2-9b-it')
    })

    it('checks Claude’s maximum summary length against the model', async () => {
        mockState.preferences.summaryModel = {
            provider: 'claude', model: 'claude-sonnet-4-5-20250929', whisperModel: 'large-v3', apiKey: null, ollamaEndpoint: null, summaryMaxTokens: null,
        }
        mockState.preferences.apiKeys.claude = 'sk-ant-saved'
        open()
        const length = await screen.findByRole('textbox', {name: 'Maximum summary length'})
        expect(await screen.findByDisplayValue('sk-ant-saved')).toBeInTheDocument()

        await userEvent.type(length, '12.5')
        expect(screen.getByText(/must be a whole number between 1 and \d+, or left empty/)).toBeInTheDocument()
        expect(save()).toBeDisabled()

        await userEvent.clear(length)
        await userEvent.type(length, '2000')
        expect(save()).toBeEnabled()
    })

    it('downloads a built-in model with its progress, and cancels it', async () => {
        open()
        await userEvent.click(await screen.findByRole('button', {name: 'Install Gemma 3 1B'}))

        expect(await screen.findByRole('progressbar', {name: 'Downloading Gemma 3 1B'})).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Cancel downloading Gemma 3 1B'}))
        await waitFor(() => expect(screen.queryByRole('progressbar')).not.toBeInTheDocument())
        expect(mockState.models.builtIn['gemma3:1b']).toEqual({type: 'not_downloaded'})
    })

    it('chooses another downloaded built-in model', async () => {
        mockState.models.builtIn['gemma3:4b'] = {type: 'available'}
        const {router} = open()
        await screen.findByText('In use')
        await userEvent.click(screen.getByRole('button', {name: 'Use Gemma 3 4B'}))
        await userEvent.click(save())

        await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
        expect(mockState.preferences.summaryModel).toMatchObject({provider: 'builtin-ai', model: 'gemma3:4b'})
    })

    it('lists an Ollama server’s models and gets the starter model', async () => {
        mockState.summaryProviders.pullStep = 50
        open()
        await userEvent.click(await screen.findByRole('radio', {name: /Ollama/}))
        expect(await screen.findByText('llama3.2:3b')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Install gemma3:1b'}))
        expect(await screen.findByText('In use')).toBeInTheDocument()
        expect(screen.getByText('gemma3:1b')).toBeInTheDocument()
        expect(save()).toBeEnabled()
    })

    it('lists another server’s models once its endpoint is typed', async () => {
        open()
        await userEvent.click(await screen.findByRole('radio', {name: /Ollama/}))
        await screen.findByText('llama3.2:3b')

        mockState.summaryProviders.ollamaModels = [{name: 'mistral:7b', id: 'f974a74358d6', size: '4.1 GB', modified: 'Yesterday'}]
        await userEvent.type(screen.getByRole('textbox', {name: 'Endpoint'}), 'http://studio:11434')
        expect(await screen.findByText('mistral:7b')).toBeInTheDocument()
    })

    it('says when Ollama isn’t running', async () => {
        mockState.summaryProviders.ollamaRunning = false
        open()
        await userEvent.click(await screen.findByRole('radio', {name: /Ollama/}))
        expect(await screen.findByText('Ollama isn’t running here')).toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Download Ollama'})).toBeInTheDocument()
    })

    it('tests a custom server and saves it with its model', async () => {
        mockState.summaryProviders.customServerError = 'Connection refused'
        const {router} = open()
        await userEvent.click(await screen.findByRole('radio', {name: /Custom server/}))
        const test = screen.getByRole('button', {name: 'Test'})
        expect(test).toBeDisabled()

        await userEvent.type(screen.getByRole('textbox', {name: 'Endpoint URL'}), 'http://localhost:8000/v1')
        await userEvent.type(screen.getByRole('textbox', {name: 'Model name'}), 'qwen2.5')
        await userEvent.click(test)
        expect(await screen.findByText('Connection refused')).toBeInTheDocument()

        mockState.summaryProviders.customServerError = null
        await userEvent.click(test)
        expect(await screen.findByText('Connection successful and response validated')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Show'}))
        await userEvent.type(await screen.findByRole('textbox', {name: 'Temperature'}), '3')
        expect(save()).toBeDisabled()
        await userEvent.clear(screen.getByRole('textbox', {name: 'Temperature'}))
        await userEvent.type(screen.getByRole('textbox', {name: 'Temperature'}), '0.2')

        await userEvent.click(save())
        await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
        expect(mockState.preferences.customServer).toMatchObject({endpoint: 'http://localhost:8000/v1', model: 'qwen2.5', temperature: 0.2})
        expect(mockState.preferences.summaryModel).toMatchObject({provider: 'custom-openai', model: 'qwen2.5'})
    })

    it('leaves without saving on Cancel', async () => {
        const {router} = open()
        await userEvent.click(await screen.findByRole('radio', {name: /Groq/}))
        await userEvent.click(screen.getByRole('button', {name: 'Cancel'}))

        await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
        expect(mockState.preferences.summaryModel?.provider).toBe('builtin-ai')
    })

    it('shows the rows its search index lists, across every provider', async () => {
        open()
        const builtIn = (await listBuiltInModels()).map(({display_name}) => shortModelName(display_name))
        const data = [...builtIn, ...mockState.summaryProviders.ollamaModels.map(({name}) => name)]
        const seen = new Set<string>()
        for (const {label} of Object.values(SUMMARY_PROVIDERS)) {
            await userEvent.click(await screen.findByRole('radio', {name: new RegExp(`^${label}`)}))
            if (label === 'Ollama') await screen.findByText('gemma3:1b')
            if (label === 'Custom server') await userEvent.click(screen.getByRole('button', {name: 'Show'}))
            if (label === 'Custom server') await screen.findByText('Top P')
            for (const shown of renderedRowLabels(data)) seen.add(shown)
        }
        expect([...seen].sort()).toEqual([...indexedLabels('summary-model')].sort())
    })
})
