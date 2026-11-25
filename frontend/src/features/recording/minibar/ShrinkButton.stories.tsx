import type {Meta, StoryObj} from '@storybook/react-vite'
import {ShrinkButton} from './ShrinkButton'

// In the recording bar beside Change inputs. Outside Tauri, and with no
// mock recording, the click does nothing.
const meta = {
    title: 'Recording/ShrinkButton',
    component: ShrinkButton,
} satisfies Meta<typeof ShrinkButton>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
