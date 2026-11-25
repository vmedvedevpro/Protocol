import type {Meta, StoryObj} from '@storybook/react-vite'
import {useModelDownloadSync} from '@/api/modelDownloadSync'
import {useSpeechConfigSync} from '@/api/speech'
import {mockState} from '@/mocks/state'
import {SettingsPage} from '../../pages/SettingsPage'
import {useAdvancedSettingsStore} from '../../store/advanced'
import {SettingsStoryWindow} from '../../stories/SettingsStoryWindow'

/** Settings with what the shell also mounts for the speech half: the download events and the speech config. */
function Page({path}: {path: string}) {
    useModelDownloadSync()
    useSpeechConfigSync()
    return <SettingsStoryWindow path={path}><SettingsPage/></SettingsStoryWindow>
}

const meta = {
    title: 'Settings/Speech',
    component: Page,
    args: {path: '/settings?section=ai'},
    beforeEach: () => {
        useAdvancedSettingsStore.setState({advanced: true})
    },
} satisfies Meta<typeof Page>

export default meta

type Story = StoryObj<typeof meta>

/** Settings › AI, the speech half: the models during and after the meeting, the words to recognize, the speakers. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Settings › Advanced: Local AI and Labs. */
export const Advanced: Story = {globals: {theme: 'light'}, args: {path: '/settings?section=advanced'}}

export const AdvancedDark: Story = {globals: {theme: 'dark'}, args: {path: '/settings?section=advanced'}}

/** Settings › Speech models: the pair for this computer, then every Parakeet and Whisper model. */
export const SpeechModels: Story = {globals: {theme: 'light'}, args: {path: '/settings/speech-models'}}

export const SpeechModelsDark: Story = {globals: {theme: 'dark'}, args: {path: '/settings/speech-models'}}

/** A Windows computer with an Intel GPU and NPU: the offer at the top of AI, with Not now. */
export const IntelOffer: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.platform = 'windows'
        mockState.intel.gpu = true
        mockState.intel.npu = true
        mockState.intel.downloadStep = 2
    },
}

/** The same computer on Speech models: Use your Intel GPU, and Parakeet waiting for Intel's libraries. */
export const IntelSpeechModels: Story = {
    ...IntelOffer,
    args: {path: '/settings/speech-models'},
}
