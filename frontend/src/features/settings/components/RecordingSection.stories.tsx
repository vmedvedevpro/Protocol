import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import type {Platform} from '@/lib/platform'
import {mockState} from '@/mocks/state'
import {StoryWindow} from '../stories/StoryWindow'
import {RecordingSection} from './RecordingSection'

const Pad = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[5]};
    padding: ${({theme}) => theme.space[4]};
    overflow-y: auto;
`

function Recording({platform}: {platform: Platform}) {
    return <StoryWindow><Pad><RecordingSection platform={platform}/></Pad></StoryWindow>
}

const meta = {
    title: 'Settings/Recording',
    component: Recording,
    args: {platform: 'windows'},
} satisfies Meta<typeof Recording>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Zoom and Teams only; the chips remove an app, + Add app opens its page (#117). */
export const ChosenApps: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.devices.recordingPreferences = {
            ...mockState.devices.recordingPreferences,
            per_app_recording_enabled: true,
            per_app_targets: [
                {id: 'Zoom.exe', name: 'Zoom', executable: 'Zoom.exe'},
                {id: 'ms-teams.exe', name: 'Microsoft Teams', executable: 'ms-teams.exe'},
            ],
        }
    },
}

/** Audio isn't saved: the folder goes and a warning says what that costs. */
export const NotSaving: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.devices.recordingPreferences = {...mockState.devices.recordingPreferences, auto_save: false}
    },
}

/** macOS records the current output: no output to choose, a note instead. */
export const MacOS: Story = {globals: {theme: 'light'}, args: {platform: 'macos'}}

/** Linux records the output only: no choice of apps. */
export const Linux: Story = {globals: {theme: 'light'}, args: {platform: 'linux'}}
