import type {Meta, StoryObj} from '@storybook/react-vite'
import {DialogStory} from '../testing/DialogStory'

const meta = {
    title: 'Dialogs/Identify speakers',
    component: DialogStory,
    // The meeting screen owns the run; the story's Identify only closes.
    args: {request: {kind: 'identify-speakers', identify: () => {}}},
} satisfies Meta<typeof DialogStory>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
