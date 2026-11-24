import type {Meta, StoryObj} from '@storybook/react-vite'
import {ThemeSwitch} from './ThemeSwitch'

const meta = {
    title: 'Placeholder/ThemeSwitch',
    component: ThemeSwitch,
} satisfies Meta<typeof ThemeSwitch>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
