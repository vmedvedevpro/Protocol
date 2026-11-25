import type {Meta, StoryObj} from '@storybook/react-vite'
import {mockState} from '@/mocks/state'
import {DialogStory} from '../DialogStory'

const meta = {
    title: 'Dialogs/Summary options',
    component: DialogStory,
    args: {request: {kind: 'summary', meetingId: 'meeting-roadmap'}},
} satisfies Meta<typeof DialogStory>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** A summary the user edited: writing it again says the edits go. */
export const Edited: Story = {
    beforeEach: () => {
        mockState.meetings.summaries['meeting-roadmap'].userEdited = true
    },
}
