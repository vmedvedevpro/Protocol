import type {Meta, StoryObj} from '@storybook/react-vite'
import {MemoryRouter} from 'react-router-dom'
import styled from 'styled-components'
import {RecordBarContext} from '@/components/screen/recordBar'
import {RecordingBar} from '../components/RecordingBar'
import {RecordingRuntime} from '../components/RecordingRuntime'
import {session} from '../store/session'
import {reset, startLiveRecording} from '../test/stories'
import {RecordingPage} from './RecordingPage'

const Window = styled.div`
    display: flex;
    flex-direction: column;
    width: ${({theme}) => theme.sizes.window.width};
    height: ${({theme}) => theme.sizes.window.height};
    background: ${({theme}) => theme.colors.bg};
`

const renderRecordBar = (idle: boolean) => <RecordingBar idle={idle}/>

// The screen as the shell shows it, with the bar docked under it, on the mock recorder.
function LivePage() {
    return (
        <MemoryRouter initialEntries={['/recording']}>
            <RecordBarContext value={renderRecordBar}>
                <RecordingRuntime/>
                <Window>
                    <RecordingPage/>
                </Window>
            </RecordBarContext>
        </MemoryRouter>
    )
}

const meta = {
    title: 'Recording/RecordingPage',
    component: LivePage,
    parameters: {layout: 'fullscreen'},
    beforeEach: reset,
} satisfies Meta<typeof LivePage>

export default meta

type Story = StoryObj<typeof meta>

/** Nothing records: how to start. */
export const NotRecording: Story = {}

/** Twelve minutes in, with the notes open; new lines keep coming in the Transcript view. */
export const Recording: Story = {beforeEach: () => startLiveRecording(6)}

export const RecordingDark: Story = {globals: {theme: 'dark'}, beforeEach: () => startLiveRecording(6)}

/** From Stop until the meeting opens: what the save is doing. */
export const Finishing: Story = {
    beforeEach: async () => {
        await startLiveRecording(6)
        session.set({phase: 'finishing', step: 'Transcribing the last 2 pieces…'})
    },
}
