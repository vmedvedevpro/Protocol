import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {CHECK_STEPS} from '@/api/speechCheck'
import {handlers} from '@/mocks/handlers'
import {mockReport, mockStep} from '@/mocks/speechCheck'
import {mockState} from '@/mocks/state'
import {SettingsStoryWindow} from '../../stories/SettingsStoryWindow'
import {SpeechCheckGroup} from './SpeechCheckGroup'

const Pad = styled.div`
    padding: ${({theme}) => theme.space[4]};
    overflow-y: auto;
`

function SpeechCheck() {
    return <SettingsStoryWindow><Pad><SpeechCheckGroup/></Pad></SettingsStoryWindow>
}

const meta = {
    title: 'Settings/Speech check',
    component: SpeechCheck,
} satisfies Meta<typeof SpeechCheck>

export default meta

type Story = StoryObj<typeof meta>
type Play = NonNullable<Story['play']>

const dark = (story: Story): Story => ({...story, globals: {theme: 'dark'}})

/** Run check, as a tester would. */
const openOffer: Play = async ({canvas, userEvent}) => {
    await userEvent.click(await canvas.findByRole('button', {name: 'Run check'}))
}

export const Idle: Story = {globals: {theme: 'light'}}

export const IdleDark = dark(Idle)

/** What the check runs; the mock has the speech models but not Nemotron, which it offers with its size. */
export const Offer: Story = {globals: {theme: 'light'}, play: openOffer}

export const OfferDark = dark(Offer)

/** The inputs of the pair still loading: no row says Ready, and Start waits. */
const availability = handlers.get_openvino_availability
export const LoadingInputs: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        handlers.get_openvino_availability = () => new Promise(() => undefined)
        return () => {
            handlers.get_openvino_availability = availability
        }
    },
    play: openOffer,
}

export const LoadingInputsDark = dark(LoadingInputs)

export const Running: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.speechCheck.status = {state: 'running', step: 'whisper', steps: [...CHECK_STEPS], done: [mockStep('parakeet')], cancelling: false}
    },
}

export const RunningDark = dark(Running)

export const Passed: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.speechCheck.status = {
            state: 'finished',
            ...mockReport([mockStep('parakeet'), mockStep('whisper'), mockStep('pyannote'), mockStep('nemotron', 'notChecked')], 'passed'),
        }
    },
}

export const PassedDark = dark(Passed)

export const Failed: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.speechCheck.status = {
            state: 'finished',
            ...mockReport([mockStep('parakeet'), mockStep('whisper', 'failed'), mockStep('pyannote'), mockStep('nemotron', 'notChecked')], 'failed'),
        }
    },
}

export const FailedDark = dark(Failed)

/** Protocol closed while Whisper ran on the graphics card. */
export const Interrupted: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.speechCheck.status = {
            state: 'interrupted',
            closedIn: 'whisper',
            remaining: ['pyannote', 'nemotron'],
            ...mockReport([mockStep('parakeet'), {...mockStep('whisper', 'closedTheApp'), ranOn: undefined, reason: 'Protocol closed while this step ran'}], 'interrupted'),
        }
    },
}

export const InterruptedDark = dark(Interrupted)
