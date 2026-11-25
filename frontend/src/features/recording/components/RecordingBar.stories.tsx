import type {Meta, StoryObj} from '@storybook/react-vite'
import {MemoryRouter} from 'react-router-dom'
import styled from 'styled-components'
import {reset, startLiveRecording} from '../test/stories'
import {setSourceMuted, togglePause} from '../store/runtime'
import {session} from '../store/session'
import {RecordingBar} from './RecordingBar'
import {RecordingRuntime} from './RecordingRuntime'

const Window = styled.div`
    width: ${({theme}) => theme.sizes.window.width};
    border-top: 1px solid ${({theme}) => theme.colors.border};
    background: ${({theme}) => theme.colors.bg};
`

// The bar with the runtime that feeds it, on the mock recorder.
function LiveBar({idle}: { idle: boolean }) {
    return (
        <MemoryRouter>
            <RecordingRuntime/>
            <Window>
                <RecordingBar idle={idle}/>
            </Window>
        </MemoryRouter>
    )
}

const meta = {
    title: 'Recording/RecordingBar',
    component: LiveBar,
    args: {idle: true},
    beforeEach: reset,
} satisfies Meta<typeof LiveBar>

export default meta

type Story = StoryObj<typeof meta>

/** Nothing records: Record, and the inputs it will use. Record starts a mock recording. */
export const Idle: Story = {}

export const IdleDark: Story = {globals: {theme: 'dark'}}

/** The start says what it waits for: loading the speech model takes seconds. */
export const Starting: Story = {
    beforeEach: () => session.set({phase: 'starting', step: 'Preparing the speech model…'}),
}

/** A running recording: the ring pauses it, each source mutes, Stop saves it. */
export const Recording: Story = {beforeEach: () => startLiveRecording()}

export const RecordingDark: Story = {globals: {theme: 'dark'}, beforeEach: () => startLiveRecording()}

export const Paused: Story = {
    beforeEach: async () => {
        await startLiveRecording()
        await togglePause()
    },
}

export const MicrophoneMuted: Story = {
    beforeEach: async () => {
        await startLiveRecording()
        await setSourceMuted('mic', true)
    },
}

/** After Stop, until the meeting opens. */
export const Finishing: Story = {
    beforeEach: () => session.set({phase: 'finishing', step: 'Transcribing the last 3 pieces…'}),
}
