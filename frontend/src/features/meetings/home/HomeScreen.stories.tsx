import type {Meta, StoryObj} from '@storybook/react-vite'
import {StoryWindow} from '@/components/screen/StoryWindow'
import {mockState} from '@/mocks/state'
import {meetingsStoryRoutes} from '../storyRoutes'

function HomeDemo({url}: { url: string }) {
    return <StoryWindow url={url} routes={meetingsStoryRoutes()}/>
}

const meta = {
    title: 'Meetings/HomeScreen',
    component: HomeDemo,
    args: {url: '/'},
} satisfies Meta<typeof HomeDemo>

export default meta

type Story = StoryObj<typeof meta>

/** The sample library in sections by date; type to search, pick a folder to filter. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** One folder selected: its actions sit in the menu after the chips. */
export const InFolder: Story = {args: {url: '/?folder=group-acme'}}

/** No meetings yet: no search, no folders, nothing to import. */
export const Empty: Story = {
    beforeEach: () => {
        mockState.meetings.meetings = []
    },
}

/** A downloaded update waits for a restart; Release notes opens a sheet. */
export const UpdateReady: Story = {
    beforeEach: () => {
        mockState.updater = {
            ...mockState.updater,
            support: {kind: 'updatable', install: 'nsis'},
            offer: {
                release: {version: '0.9.0', notes: 'Summaries keep their action items.\nThe player skips with the arrow keys.', date: null},
                downloaded: true,
                manualOnly: false,
                waitingForRecording: false,
            },
        }
    },
}
