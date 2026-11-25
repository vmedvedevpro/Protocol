import type {Meta, StoryObj} from '@storybook/react-vite'
import {DialogStory} from '../DialogStory'

const meta = {
    title: 'Dialogs/Export',
    component: DialogStory,
    args: {request: {kind: 'export', meetingId: 'meeting-acme-review'}},
} satisfies Meta<typeof DialogStory>

export default meta

type Story = StoryObj<typeof meta>

/** The whole record as Markdown, with the link style; Export asks where to save. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** A meeting without a summary: only its transcript can be exported. */
export const TranscriptOnly: Story = {args: {request: {kind: 'export', meetingId: 'meeting-untitled'}}}
