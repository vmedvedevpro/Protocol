import type {Meta, StoryObj} from '@storybook/react-vite'
import {DialogStory} from '../DialogStory'

const meta = {
    title: 'Dialogs/Who said this',
    component: DialogStory,
    // The sample meeting's second line, its first of Speaker 1.
    args: {request: {kind: 'speaker', meetingId: 'meeting-untitled', speaker: 'Speaker 1', lineIds: ['meeting-untitled-t1']}},
} satisfies Meta<typeof DialogStory>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
