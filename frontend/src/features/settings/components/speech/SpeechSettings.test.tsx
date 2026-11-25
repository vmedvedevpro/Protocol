import {createElement} from 'react'
import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {INTEL_OFFER_DISMISSED_KEY} from '@/api/intel'
import {LABS_KEY} from '@/api/labs'
import {POST_CALL_WHISPER_MODEL} from '@/api/models'
import {GPU_VERSION_ID} from '@/mocks/intel'
import {mockState} from '@/mocks/state'
import {SettingsPage} from '../../pages/SettingsPage'
import {useAdvancedSettingsStore} from '../../store/advanced'
import {renderSettings} from '../../testing'

const renderSection = (section: 'ai' | 'advanced') => {
    useAdvancedSettingsStore.setState({advanced: true})
    return renderSettings(createElement(SettingsPage), `/settings?section=${section}`)
}
const group = (name: string) => screen.getByRole('region', {name})

describe('Settings › AI, speech', () => {
    it('offers the installed models after the meeting, and saves the one chosen', async () => {
        renderSection('ai')
        const after = await screen.findByRole('combobox', {name: 'After the meeting'})
        await waitFor(() => expect(after).toHaveTextContent('Same as during the meeting'))

        await userEvent.click(after)
        await userEvent.click(await screen.findByRole('option', {name: 'Whisper · Large V3 Turbo Compressed'}))

        await waitFor(() => expect(mockState.speech.postCallConfig).toEqual({provider: 'whisper', model: POST_CALL_WHISPER_MODEL}))
    })

    it('saves the words to recognize and counts them against the limit', async () => {
        renderSection('ai')
        const field = await screen.findByRole('textbox', {name: 'Words to recognize'})
        await waitFor(() => expect(field).toHaveValue('Acme\nPriya Shah\nParakeet'))
        const save = within(group('Vocabulary')).getByRole('button', {name: 'Save'})
        expect(save).toBeDisabled()

        await userEvent.clear(field)
        await userEvent.type(field, 'Contoso')
        expect(within(group('Vocabulary')).getByText('7 / 1000')).toBeInTheDocument()
        await userEvent.click(save)

        await waitFor(() => expect(mockState.speech.vocabulary.global).toBe('Contoso'))
        await waitFor(() => expect(save).toBeDisabled())
    })

    it('downloads Nemotron when it is chosen, and native chooses it once it is there', async () => {
        mockState.diarization.downloadStep = 100
        renderSection('ai')
        const nemotron = await screen.findByRole('radio', {name: /NVIDIA Nemotron/})
        await waitFor(() => expect(screen.getByRole('radio', {name: /Pyannote/})).toBeChecked())

        await userEvent.click(nemotron)

        await waitFor(() => expect(nemotron).toBeChecked())
        expect(mockState.diarization).toMatchObject({engine: 'nemotron', nemotronInstalled: true})
        expect(await screen.findByRole('slider', {name: 'Speech threshold'})).toBeInTheDocument()
    })

    it('removes Nemotron after asking, and Pyannote identifies speakers again', async () => {
        mockState.diarization.engine = 'nemotron'
        mockState.diarization.nemotronInstalled = true
        renderSection('ai')
        await userEvent.click(await screen.findByRole('button', {name: 'Remove NVIDIA Nemotron'}))
        await userEvent.click(within(await screen.findByRole('dialog', {name: 'Remove NVIDIA Nemotron?'})).getByRole('button', {name: 'Remove'}))

        await waitFor(() => expect(screen.getByRole('radio', {name: /Pyannote/})).toBeChecked())
        expect(mockState.diarization.nemotronInstalled).toBe(false)
    })

    it('opens Speech models from its row', async () => {
        const {router} = renderSection('ai')
        await userEvent.click(await screen.findByRole('button', {name: /Downloaded models/}))

        expect(router.state.location.pathname).toBe('/settings/speech-models')
        expect(await screen.findByRole('region', {name: 'For this computer'})).toBeInTheDocument()
    })
})

describe('Settings › Speech models', () => {
    const renderPage = () => renderSettings(createElement(SettingsPage), '/settings/speech-models')

    it('downloads a model, then removes it after asking', async () => {
        mockState.models.downloadStep = 100
        renderPage()
        const whisper = await screen.findByRole('region', {name: 'Whisper'})
        await userEvent.click(await within(whisper).findByRole('button', {name: 'Download Small'}))

        await waitFor(() => expect(mockState.models.whisper.small).toBe('Available'))
        await userEvent.click(await within(whisper).findByRole('button', {name: 'Remove Small'}))
        const sheet = await screen.findByRole('dialog', {name: 'Remove Small?'})
        await userEvent.click(within(sheet).getByRole('button', {name: 'Remove'}))

        await waitFor(() => expect(mockState.models.whisper.small).toBe('Missing'))
        expect(await within(whisper).findByRole('button', {name: 'Download Small'})).toBeInTheDocument()
    })

    it('says what the pair for this computer is used for', async () => {
        renderPage()
        const pair = await screen.findByRole('region', {name: 'For this computer'})

        // After meetings follows the live model until Whisper is chosen.
        expect(await within(pair).findByText('In use during and after meetings')).toBeInTheDocument()
        expect(within(pair).getByText(/^After meetings/)).toBeInTheDocument()
        expect(within(pair).queryByText('Use your Intel GPU')).not.toBeInTheDocument()
    })

    it('removes Whisper Large V3 Turbo through the optional removal', async () => {
        renderPage()
        const pair = await screen.findByRole('region', {name: 'For this computer'})
        await userEvent.click(await within(pair).findByRole('button', {name: 'Remove Whisper · Large V3 Turbo Compressed'}))
        await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', {name: 'Remove'}))

        await waitFor(() => expect(mockState.models.whisper[POST_CALL_WHISPER_MODEL]).toBe('Missing'))
    })
})

describe('Settings › AI, the Intel offer', () => {
    const onIntelGpu = () => {
        mockState.platform = 'windows'
        mockState.intel.gpu = true
    }

    it('switches Whisper to the Intel GPU version, which native makes the after-meeting model', async () => {
        onIntelGpu()
        mockState.intel.downloadStep = 100
        renderSection('ai')
        const offer = await screen.findByRole('region', {name: 'Intel GPU and NPU offer'})
        expect(within(offer).getByText('Protocol can use your Intel GPU')).toBeInTheDocument()

        await userEvent.click(within(offer).getByRole('button', {name: 'Switch'}))

        await waitFor(() => expect(mockState.speech.postCallConfig).toEqual({provider: 'whisper', model: GPU_VERSION_ID}))
        await waitFor(() => expect(screen.queryByRole('region', {name: 'Intel GPU and NPU offer'})).not.toBeInTheDocument())
    })

    it('keeps Not now for the device', async () => {
        onIntelGpu()
        renderSection('ai')
        const offer = await screen.findByRole('region', {name: 'Intel GPU and NPU offer'})

        await userEvent.click(within(offer).getByRole('button', {name: 'Not now'}))

        await waitFor(() => expect(screen.queryByRole('region', {name: 'Intel GPU and NPU offer'})).not.toBeInTheDocument())
        expect(JSON.parse(localStorage.getItem(INTEL_OFFER_DISMISSED_KEY) ?? '[]')).toEqual(['Intel GPU'])
    })
})

describe('Settings › Advanced, speech', () => {
    it('keeps the WebView Labs in meetily-labs-v1 and the native ones natively', async () => {
        renderSection('advanced')
        const labs = await screen.findByRole('region', {name: 'Labs'})

        await userEvent.click(within(labs).getByRole('switch', {name: 'Waveform scrubbing'}))
        expect(JSON.parse(localStorage.getItem(LABS_KEY) ?? '{}')).toMatchObject({transcriptScrubbing: true})

        const guard = within(labs).getByRole('switch', {name: 'Whisper silence guard'})
        await waitFor(() => expect(guard).toBeEnabled())
        await userEvent.click(guard)
        await waitFor(() => expect(mockState.labs.whisperSilenceGuard).toBe(true))
        // Parakeet on the GPU is Windows only; the tests' platform is not.
        expect(within(labs).queryByRole('switch', {name: 'Parakeet on the GPU'})).not.toBeInTheDocument()
    })

    it('unloads the speech models', async () => {
        mockState.live.loaded = {parakeet: true, whisper: false}
        renderSection('advanced')
        const local = await screen.findByRole('region', {name: 'Local AI'})
        const unload = within(local).getByRole('button', {name: 'Unload speech models'})
        await waitFor(() => expect(unload).toBeEnabled())

        await userEvent.click(unload)

        expect(await screen.findByText('Speech models unloaded')).toBeInTheDocument()
    })
})
