import {createElement} from 'react'
import {act, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {recordingPhase} from '@/api/recordingPhase'
import {handlers} from '@/mocks/handlers'
import {mockReport, mockStep} from '@/mocks/speechCheck'
import {mockState} from '@/mocks/state'
import {SettingsPage} from '../../pages/SettingsPage'
import {useAdvancedSettingsStore} from '../../store/advanced'
import {renderSettings} from '../../testing'
import {deviceWords} from './speechCheckText'

const renderAdvanced = () => {
    useAdvancedSettingsStore.setState({advanced: true})
    return renderSettings(createElement(SettingsPage), '/settings?section=advanced')
}
const group = () => screen.getByRole('region', {name: 'Speech check'})
const runCheck = async () => userEvent.click(await within(await screen.findByRole('region', {name: 'Speech check'})).findByRole('button', {name: 'Run check'}))

describe('Settings › Advanced › Speech check', () => {
    it('is idle with one line on what it does, and is off during a recording', async () => {
        renderAdvanced()
        const check = await screen.findByRole('region', {name: 'Speech check'})
        expect(within(check).getByText(/Runs each speech model on a short sample/)).toBeInTheDocument()
        await waitFor(() => expect(within(check).getByRole('button', {name: 'Run check'})).toBeEnabled())
        act(() => recordingPhase.set('recording'))
        expect(within(check).getByRole('button', {name: 'Run check'})).toBeDisabled()
        expect(within(check).getByText('Can’t run during a recording')).toBeInTheDocument()
        act(() => recordingPhase.set('idle'))
    })

    it('lists what it will run and offers the models that are not here, with their sizes', async () => {
        renderAdvanced()
        await runCheck()
        const check = group()
        // The mock has the speech models but not Nemotron.
        expect((await within(check).findAllByText('Ready')).length).toBeGreaterThan(0)
        expect(within(check).getByRole('button', {name: /Install NVIDIA Nemotron/})).toBeInTheDocument()
        expect(within(check).getAllByText(/Not checked unless downloaded/).length).toBeGreaterThan(0)
        // Back returns to idle without starting anything.
        await userEvent.click(within(check).getByRole('button', {name: 'Back'}))
        expect(await within(group()).findByRole('button', {name: 'Run check'})).toBeInTheDocument()
        expect(mockState.speechCheck.plans).toHaveLength(0)
    })

    it('offers Start only once the inputs of the choice have loaded, and never says Ready before', async () => {
        const availability = handlers.get_openvino_availability
        let answer: (value: unknown) => void = () => undefined
        handlers.get_openvino_availability = () => new Promise((resolve) => { answer = resolve })
        try {
            renderAdvanced()
            await runCheck()
            const check = group()
            expect((await within(check).findAllByText('Looking for the models on this computer')).length).toBeGreaterThan(0)
            expect(within(check).queryByText('Ready')).not.toBeInTheDocument()
            expect(within(check).getByRole('button', {name: 'Start check'})).toBeDisabled()
            await act(async () => answer(await availability({})))
            expect((await within(check).findAllByText('Ready')).length).toBeGreaterThan(0)
            expect(within(check).getByRole('button', {name: 'Start check'})).toBeEnabled()
        } finally {
            handlers.get_openvino_availability = availability
        }
    })

    it('says so when no model was checked, in a live region', async () => {
        mockState.speechCheck.status = {state: 'finished', ...mockReport(['parakeet', 'whisper', 'pyannote', 'nemotron'].map((kind) => mockStep(kind as never, 'notChecked')), 'nothingChecked')}
        renderAdvanced()
        const check = await screen.findByRole('region', {name: 'Speech check'})
        expect(await within(check).findByRole('status')).toHaveTextContent('No model was checked: none of them is on this computer')
    })

    it('runs the pair, reports declined models as not checked, and ends with Copy and Save', async () => {
        renderAdvanced()
        await runCheck()
        await userEvent.click(await within(group()).findByRole('button', {name: 'Start check'}))

        await waitFor(() => expect(mockState.speechCheck.plans).toHaveLength(1))
        const [plan] = mockState.speechCheck.plans
        expect(plan).toMatchObject({liveModel: 'parakeet-tdt-0.6b-v3-int8', postMeetingModel: 'large-v3-turbo-q5_0'})
        expect(plan.declined).toEqual(['nemotron'])

        const check = group()
        expect(await within(check).findByRole('button', {name: 'Copy report'})).toBeInTheDocument()
        expect(within(check).getByRole('button', {name: 'Save report'})).toBeInTheDocument()
        expect(within(check).getAllByText('On the processor, passed')).toHaveLength(2)
        expect(within(check).getByText('On the graphics card, passed')).toBeInTheDocument()
        expect(within(check).getAllByText('Not checked')).toHaveLength(1)
        // The whole report shows before it is copied.
        expect(within(check).getByLabelText('Speech check report')).toHaveTextContent('Protocol speech check: passed')
    })

    it('saves the report where the tester chooses', async () => {
        mockState.saveDialogPath = '/home/tester/report.txt'
        mockState.speechCheck.status = {state: 'finished', ...mockReport([mockStep('parakeet')], 'passed')}
        renderAdvanced()
        await userEvent.click(await within(await screen.findByRole('region', {name: 'Speech check'})).findByRole('button', {name: 'Save report'}))
        await waitFor(() => expect(mockState.dialogs.writtenFiles).toHaveLength(1), {timeout: 3000})
        expect(new TextDecoder().decode(mockState.dialogs.writtenFiles[0])).toContain('Protocol speech check: passed')
    })

    it('shows the current step while it runs, and Cancel ends it with a report', async () => {
        mockState.speechCheck.autoFinish = false
        renderAdvanced()
        await runCheck()
        await userEvent.click(await within(group()).findByRole('button', {name: 'Start check'}))
        expect((await within(group()).findAllByText('Checking Parakeet')).length).toBeGreaterThan(0)

        await userEvent.click(within(group()).getByRole('button', {name: 'Cancel'}))
        expect(await within(group()).findByText('The check was cancelled')).toBeInTheDocument()
        expect(within(group()).getAllByText('Cancelled')).toHaveLength(4)
        expect(within(group()).getByRole('button', {name: 'Copy report'})).toBeInTheDocument()
    })

    it('names a failed model and its reason', async () => {
        mockState.speechCheck.status = {
            state: 'finished',
            ...mockReport([mockStep('parakeet'), mockStep('whisper', 'failed'), mockStep('pyannote'), mockStep('nemotron', 'notChecked')], 'failed'),
        }
        renderAdvanced()
        const check = await screen.findByRole('region', {name: 'Speech check'})
        expect(await within(check).findByText('A model did not pass')).toBeInTheDocument()
        expect(within(check).getByText('On the graphics card, failed')).toBeInTheDocument()
        expect(within(check).getByText(/92% of its words wrong/)).toBeInTheDocument()
    })

    it('after Protocol closed during a step, says which and runs the remaining steps', async () => {
        const closed = {...mockStep('whisper', 'closedTheApp'), ranOn: undefined, reason: 'Protocol closed while this step ran'}
        mockState.speechCheck.status = {
            state: 'interrupted',
            closedIn: 'whisper',
            remaining: ['pyannote', 'nemotron'],
            ...mockReport([mockStep('parakeet'), closed], 'interrupted'),
        }
        renderAdvanced()
        const check = await screen.findByRole('region', {name: 'Speech check'})
        expect(await within(check).findByText('Protocol closed while checking Whisper. Still to check: Pyannote, NVIDIA Nemotron')).toBeInTheDocument()
        expect(within(check).getByText('Protocol closed here')).toBeInTheDocument()
        expect(within(check).getByRole('button', {name: 'Copy report'})).toBeInTheDocument()

        await userEvent.click(within(check).getByRole('button', {name: 'Run the remaining steps'}))
        await waitFor(() => expect(within(group()).getByText('Protocol closed while checking Whisper')).toBeInTheDocument())
        expect(within(group()).queryByRole('button', {name: 'Run the remaining steps'})).not.toBeInTheDocument()
        // The step that closed the app stays in the report; the rest ran.
        expect(within(group()).getByText('Protocol closed here')).toBeInTheDocument()
        expect(within(group()).getAllByText(/passed$/)).toHaveLength(3)
    })

    it('words devices as the rest of Settings does', () => {
        expect(deviceWords('Intel GPU (OpenVINO GPU.0)')).toBe('Intel GPU')
        expect(deviceWords('GPU (Vulkan): AMD Radeon RX 7600')).toBe('graphics card')
        expect(deviceWords('GPU (DirectML adapter 0)')).toBe('graphics card')
        expect(deviceWords('Intel NPU')).toBe('Intel NPU')
        expect(deviceWords('processor')).toBe('processor')
        // A device this list does not know yet keeps native's name.
        expect(deviceWords('Qualcomm Hexagon NPU')).toBe('Qualcomm Hexagon NPU')
    })
})
