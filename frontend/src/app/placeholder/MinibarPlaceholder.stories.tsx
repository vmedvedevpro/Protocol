import type {Meta, StoryObj} from '@storybook/react-vite'
import {MinibarPlaceholder} from './MinibarPlaceholder'

const meta = {
    title: 'Placeholder/MinibarPlaceholder',
    component: MinibarPlaceholder,
} satisfies Meta<typeof MinibarPlaceholder>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
