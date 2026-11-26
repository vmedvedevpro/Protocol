import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {CHECK_STEPS} from '@/api/speechCheck'
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

/** Run check lists the models, offers Nemotron's download, and Start runs one step a tick. */
export const Idle: Story = {globals: {theme: 'light'}}

export const IdleDark: Story = {globals: {theme: 'dark'}}

export const Running: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.speechCheck.status = {state: 'running', step: 'whisper', steps: [...CHECK_STEPS], done: [mockStep('parakeet')], cancelling: false}
    },
}

export const Failed: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.speechCheck.status = {
            state: 'finished',
            ...mockReport([mockStep('parakeet'), mockStep('whisper', 'failed'), mockStep('pyannote'), mockStep('nemotron', 'notChecked')], 'failed'),
        }
    },
}

export const FailedDark: Story = {globals: {theme: 'dark'}, beforeEach: Failed.beforeEach}

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
