import {type ReactNode, useEffect, useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {MemoryRouter} from 'react-router-dom'
import styled from 'styled-components'
import {within} from 'storybook/test'
import {useModelDownloadSync} from '@/api/modelDownloadSync'
import {downloadKey, PARAKEET_MODEL} from '@/api/models'
import {onboardingStatusQuery} from '@/api/onboarding'
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
// and starts its downloads afresh. First launch mounts once the status is
// read, as behind the startup gate, so it opens on the step saved last.
function OwnQueryClient({children}: { children: ReactNode }) {
    const [client] = useState(() => new QueryClient({defaultOptions: {queries: {retry: false}}}))
    const [read, setRead] = useState(false)
    useEffect(() => {
        void client.prefetchQuery(onboardingStatusQuery).then(() => setRead(true))
    }, [client])
    if (!read) return null
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

/** Step 2: Parakeet downloading, Whisper queued, summaries left for later, the ring following the microphone. */
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

type Play = NonNullable<Story['play']>

/** Chooses how summaries are written, as a user would. */
const chooseSummary = (name: RegExp): Play => async ({canvas, userEvent}) => {
    await userEvent.click(await canvas.findByRole('radio', {name}))
}

/** Summaries on this computer, before Install: Done waits for it, or for Later. */
export const SummaryOnThisComputer: Story = {globals: {theme: 'light'}, beforeEach: onSecondStep, play: chooseSummary(/On this computer/)}

export const SummaryOnThisComputerDark: Story = {...SummaryOnThisComputer, globals: {theme: 'dark'}}

/** The built-in model downloading after Install, with Cancel; Done selects it. */
export const SummaryInstalling: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        onSecondStep()
        mockState.models.downloadStep = 2
    },
    play: async (context) => {
        await chooseSummary(/On this computer/)(context)
        await context.userEvent.click(await context.canvas.findByRole('button', {name: /^Install /}))
    },
}

/** A provider with the user's key: Claude chosen, its key and model next. */
export const SummaryWithKey: Story = {
    globals: {theme: 'light'},
    beforeEach: onSecondStep,
    play: async (context) => {
        const {canvas, userEvent} = context
        await chooseSummary(/With your API key/)(context)
        await userEvent.click(await canvas.findByRole('combobox', {name: 'Provider'}))
        // The list opens in a portal, outside the story's canvas.
        await userEvent.click(await within(document.body).findByRole('option', {name: 'Claude'}))
    },
}

export const SummaryWithKeyDark: Story = {...SummaryWithKey, globals: {theme: 'dark'}}
