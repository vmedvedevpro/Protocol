import type {Meta, StoryObj} from '@storybook/react-vite'
import {DialogStory} from '../testing/DialogStory'

const meta = {
    title: 'Dialogs/Template editor',
    component: DialogStory,
    args: {request: {kind: 'template', templateId: 'standard_meeting'}},
} satisfies Meta<typeof DialogStory>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

export const New: Story = {args: {request: {kind: 'template'}}}
