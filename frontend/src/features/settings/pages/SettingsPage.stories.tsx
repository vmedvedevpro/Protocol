import type {Meta, StoryObj} from '@storybook/react-vite'
import {recordingPhase} from '@/api/recordingPhase'
import {useAdvancedSettingsStore} from '../store/advanced'
import {SettingsStoryWindow} from '../stories/SettingsStoryWindow'
import {SettingsPage} from './SettingsPage'

function Page({path, width}: {path?: string, width?: string}) {
    return <SettingsStoryWindow path={path} width={width}><SettingsPage/></SettingsStoryWindow>
}

const meta = {
    title: 'Settings/Page',
    component: Page,
    // Simple until a story or a click turns Advanced on; the switch is stored.
    beforeEach: () => {
        useAdvancedSettingsStore.setState({advanced: false})
        recordingPhase.set('idle')
    },
} satisfies Meta<typeof Page>

export default meta

type Story = StoryObj<typeof meta>

/** The simple page: name, theme, microphone, language and summaries. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Every section in tabs; General holds the look, the name, updates and About. */
export const Advanced: Story = {
    globals: {theme: 'light'},
    args: {path: '/settings?section=general'},
}

/**
 * The tab row at the width the window opens at, 460 px: the four tabs, a
 * little denser, and the search beside them with its placeholder whole.
 */
export const AdvancedDefaultWidth: Story = {
    globals: {theme: 'light'},
    args: {path: '/settings?section=general', width: '460px'},
}

/**
 * At the window's minimum, 360 px: the four tabs whole, and the search on a
 * line of its own under them, since it has no room beside them.
 */
export const AdvancedNarrowest: Story = {
    globals: {theme: 'light'},
    args: {path: '/settings?section=general', width: '360px'},
}

export const AdvancedNarrowestDark: Story = {
    globals: {theme: 'dark'},
    args: {path: '/settings?section=general', width: '360px'},
}

export const AdvancedDark: Story = {
    globals: {theme: 'dark'},
    args: {path: '/settings?section=general'},
}

export const Recording: Story = {
    globals: {theme: 'light'},
    args: {path: '/settings?section=recording'},
}

export const RecordingDark: Story = {
    globals: {theme: 'dark'},
    args: {path: '/settings?section=recording'},
}

/** The tray's Check for Updates…: General, scrolled to Updates. */
export const FromTheTray: Story = {
    globals: {theme: 'light'},
    args: {path: '/settings?section=about'},
}

/** A recording runs: the meeting language waits for it to be saved. */
export const WhileRecording: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        recordingPhase.set('recording')
    },
}

/** Summaries in full: languages as chips, the model, the templates. */
export const Ai: Story = {
    globals: {theme: 'light'},
    args: {path: '/settings?section=ai'},
}

export const AiDark: Story = {
    globals: {theme: 'dark'},
    args: {path: '/settings?section=ai'},
}

/** The data folder and AI agents. */
export const AdvancedSection: Story = {
    globals: {theme: 'light'},
    args: {path: '/settings?section=advanced'},
}

export const AdvancedSectionDark: Story = {
    globals: {theme: 'dark'},
    args: {path: '/settings?section=advanced'},
}

/** A search: the rows of every section that match, then the pages whose rows do. */
export const Searching: Story = {
    globals: {theme: 'light'},
    args: {path: '/settings?section=general&q=model'},
}

export const SearchingDark: Story = {
    globals: {theme: 'dark'},
    args: {path: '/settings?section=general&q=model'},
}

export const NothingMatches: Story = {
    globals: {theme: 'light'},
    args: {path: '/settings?section=general&q=zzzz'},
}
