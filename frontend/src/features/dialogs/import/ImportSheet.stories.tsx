import type {Meta, StoryObj} from '@storybook/react-vite'
import {mockState} from '@/mocks/state'
import {DialogStory} from '../DialogStory'

const meta = {
    title: 'Dialogs/Import',
    component: DialogStory,
    args: {request: {kind: 'import'}},
} satisfies Meta<typeof DialogStory>

export default meta

type Story = StoryObj<typeof meta>

/** No file yet: drop one on the window, or Choose a file (the mock picks a 38-minute call). */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** A file dropped on the window: title, folder and Advanced options; Import runs it in about 3 s. */
export const Dropped: Story = {args: {request: {kind: 'import', path: '/home/user/Recordings/client-call-nov-21.m4a'}}}

/** An import that fails halfway: native's reason and Try again. */
export const Fails: Story = {
    args: {request: {kind: 'import', path: '/home/user/Recordings/client-call-nov-21.m4a'}},
    beforeEach: () => {
        mockState.dialogs.importError = 'No transcription model is available. Download one in Settings.'
    },
}
