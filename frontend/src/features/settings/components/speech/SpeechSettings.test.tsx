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

    it('adds words to recognize one at a time, ignores repeats, and removes them, saving each change', async () => {
        renderSection('ai')
        const vocabulary = group('Vocabulary')
        const field = await within(vocabulary).findByRole('textbox', {name: 'Words to recognize'})
        // The stored text shows as entries.
        expect(await within(vocabulary).findByRole('button', {name: 'Remove Priya Shah'})).toBeInTheDocument()
        // The row's label names the field; it is not said twice.
        expect(within(vocabulary).getAllByText('Words to recognize')).toHaveLength(1)
        const add = within(vocabulary).getByRole('button', {name: 'Add'})
        expect(add).toBeDisabled()

        await userEvent.type(field, '  Contoso {Enter}')
        await waitFor(() => expect(mockState.speech.vocabulary.global).toBe('Acme\nPriya Shah\nParakeet\nContoso'))
        expect(field).toHaveValue('')

        await userEvent.type(field, 'acme')
        await userEvent.click(add)
        expect(field).toHaveValue('')
        expect(within(vocabulary).getAllByRole('button', {name: /^Remove /})).toHaveLength(4)

        await userEvent.click(within(vocabulary).getByRole('button', {name: 'Remove Priya Shah'}))
        await waitFor(() => expect(mockState.speech.vocabulary.global).toBe('Acme\nParakeet\nContoso'))
        await waitFor(() => expect(within(vocabulary).queryByRole('button', {name: 'Remove Priya Shah'})).not.toBeInTheDocument())
    })

    it('offers Nemotron to install instead of as a choice, and makes it a choice once installed', async () => {
        mockState.diarization.downloadStep = 100
        renderSection('ai')
        await waitFor(() => expect(screen.getByRole('radio', {name: /Pyannote/})).toBeChecked())
        expect(screen.queryByRole('radio', {name: /NVIDIA Nemotron/})).not.toBeInTheDocument()

        await userEvent.click(await screen.findByRole('button', {name: 'Install NVIDIA Nemotron'}))

        // Installing is not choosing: the radio appears, and Pyannote stays chosen until it is picked.
        const nemotron = await screen.findByRole('radio', {name: /NVIDIA Nemotron/})
        expect(nemotron).not.toBeChecked()
        expect(mockState.diarization).toMatchObject({engine: 'pyannote', nemotronInstalled: true})

        await userEvent.click(nemotron)
        await waitFor(() => expect(nemotron).toBeChecked())
        expect(mockState.diarization.engine).toBe('nemotron')
        expect(await screen.findByRole('slider', {name: 'Speech threshold'})).toBeInTheDocument()
    })

    it('cancels Nemotron’s install, and it stays offered', async () => {
        renderSection('ai')
        await userEvent.click(await screen.findByRole('button', {name: 'Install NVIDIA Nemotron'}))
        await userEvent.click(await screen.findByRole('button', {name: 'Cancel downloading NVIDIA Nemotron'}))

        expect(await screen.findByRole('button', {name: 'Install NVIDIA Nemotron'})).toBeInTheDocument()
        expect(mockState.diarization).toMatchObject({engine: 'pyannote', nemotronInstalled: false})
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('only switches between installed speaker engines', async () => {
        mockState.diarization.nemotronInstalled = true
        renderSection('ai')
        await userEvent.click(await screen.findByRole('radio', {name: /NVIDIA Nemotron/}))
        await waitFor(() => expect(mockState.diarization.engine).toBe('nemotron'))

        await userEvent.click(screen.getByRole('radio', {name: /Pyannote/}))
        await waitFor(() => expect(mockState.diarization.engine).toBe('pyannote'))
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
        await userEvent.click(await within(whisper).findByRole('button', {name: 'Install Small'}))

        await waitFor(() => expect(mockState.models.whisper.small).toBe('Available'))
        await userEvent.click(await within(whisper).findByRole('button', {name: 'Remove Small'}))
        const sheet = await screen.findByRole('dialog', {name: 'Remove Small?'})
        await userEvent.click(within(sheet).getByRole('button', {name: 'Remove'}))

        await waitFor(() => expect(mockState.models.whisper.small).toBe('Missing'))
        expect(await within(whisper).findByRole('button', {name: 'Install Small'})).toBeInTheDocument()
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

        await userEvent.click(within(offer).getByRole('button', {name: 'Install'}))

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
