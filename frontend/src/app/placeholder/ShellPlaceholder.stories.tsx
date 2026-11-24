import type {Meta, StoryObj} from '@storybook/react-vite'
import {ShellPlaceholder} from './ShellPlaceholder'

const meta = {
    title: 'Placeholder/ShellPlaceholder',
    component: ShellPlaceholder,
} satisfies Meta<typeof ShellPlaceholder>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
