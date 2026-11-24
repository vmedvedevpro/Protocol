import {type ReactNode, useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {MemoryRouter} from 'react-router-dom'
import styled from 'styled-components'
import {useModelDownloadSync} from '@/api/modelDownloadSync'
import {downloadKey, PARAKEET_MODEL} from '@/api/models'
import {createMockModels} from '@/mocks/models'
import {completedOnboarding} from '@/mocks/onboarding'
import {mockState} from '@/mocks/state'
import {FirstLaunch} from './FirstLaunch'

// The window the design is drawn for, without its title bar.
const Window = styled.div`
    display: flex;
    flex-direction: column;
    width: ${({theme}) => theme.sizes.window.width};
    height: ${({theme}) => theme.sizes.window.height};
    overflow: hidden;
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.lg};
    background: ${({theme}) => theme.colors.bg};
`

// What the shell mounts in front of first launch: the download events.
function DownloadSync() {
    useModelDownloadSync()
    return null
}

// The download run belongs to a query client, so each story gets its own
// and starts its downloads afresh.
function OwnQueryClient({children}: { children: ReactNode }) {
    const [client] = useState(() => new QueryClient({defaultOptions: {queries: {retry: false}}}))
    return (
        <QueryClientProvider client={client}>
            <DownloadSync/>
            {children}
        </QueryClientProvider>
    )
}

const newInstall = () => {
    mockState.onboarding = null
    mockState.models = createMockModels({fresh: true})
}

const onSecondStep = () => {
    newInstall()
    mockState.onboarding = {...completedOnboarding(), completed: false, current_step: 2}
}

const meta = {
    title: 'Onboarding/FirstLaunch',
    component: FirstLaunch,
    parameters: {layout: 'centered'},
    decorators: [(Story) => (
        <OwnQueryClient>
            <MemoryRouter>
                <Window><Story/></Window>
            </MemoryRouter>
        </OwnQueryClient>
    )],
    args: {platform: 'windows'},
    beforeEach: newInstall,
} satisfies Meta<typeof FirstLaunch>

export default meta

type Story = StoryObj<typeof meta>

/** Step 1: the name. The downloads have started behind it. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Step 2: Parakeet downloading, the others queued, the ring following the microphone. */
export const Models: Story = {globals: {theme: 'light'}, beforeEach: onSecondStep}

export const ModelsDark: Story = {globals: {theme: 'dark'}, beforeEach: onSecondStep}

/** Parakeet fails halfway; the others go on, and Retry downloads it again. */
export const DownloadFailed: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        onSecondStep()
        mockState.models.failing = [downloadKey('parakeet', PARAKEET_MODEL)]
    },
}

/** A reinstall that kept its models: nothing to download. */
export const Installed: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        onSecondStep()
        mockState.models = createMockModels({fresh: false})
    },
}

/** macOS refuses the microphone; Test computer audio runs the Audio Capture probe. */
export const MicrophoneRefused: Story = {
    globals: {theme: 'light'},
    args: {platform: 'macos'},
    beforeEach: () => {
        onSecondStep()
        mockState.platform = 'macos'
        mockState.permissions.microphone = false
        mockState.permissions.systemAudio = 'not_determined'
    },
}
