import {createElement} from 'react'
import {screen} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {getParakeetModels, getWhisperModels} from '@/api/models'
import {mockState} from '@/mocks/state'
import {renderedRowLabels, renderSettings} from '../testing'
import {SettingsPage} from './SettingsPage'
import {indexedLabels} from './settingsPages'

// The other pages are held to their index in their own tests.
describe('Search index of Speech models', () => {
    it('lists the rows the page shows besides the models', async () => {
        // The models' rows are data, not in the index: named "Parakeet · …" in
        // the pair for this computer, by their own name in the lists.
        const models = [...await getParakeetModels(), ...await getWhisperModels()]
            .map((model) => (model.display_name || model.name).replace(/^(Parakeet|Whisper)\s+/i, ''))
        const ownRows = () => renderedRowLabels(models).filter((label) => !label.includes(' · '))
        mockState.platform = 'windows'

        // An Intel NPU alone asks for Intel's libraries; with an Intel GPU, its version brings them.
        mockState.intel.npu = true
        const npu = renderSettings(createElement(SettingsPage), '/settings/speech-models')
        await screen.findByText("Intel's libraries")
        const seen = new Set(ownRows())
        npu.unmount()

        mockState.intel.gpu = true
        renderSettings(createElement(SettingsPage), '/settings/speech-models')
        await screen.findByText('Whisper for the Intel GPU')
        for (const label of ownRows()) seen.add(label)

        expect([...seen].sort()).toEqual([...indexedLabels('speech-models')].sort())
    })
})

describe('Whisper for the Intel GPU on Linux', () => {
    it('names the driver package the GPU still needs', async () => {
        mockState.platform = 'linux'
        mockState.intel.gpu = true
        mockState.intel.driver = 'Running Whisper on the Intel GPU needs Intel\'s OpenCL driver: install the intel-opencl-icd package'
        renderSettings(createElement(SettingsPage), '/settings/speech-models')
        await screen.findByText('Whisper for the Intel GPU')
        expect(await screen.findByText(/install the intel-opencl-icd package/)).toBeTruthy()
    })
})
