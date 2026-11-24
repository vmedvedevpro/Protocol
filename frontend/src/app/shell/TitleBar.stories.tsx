import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import type {Platform} from '@/lib/platform'
import {TitleBar} from './TitleBar'

// The strip at the top of the 460 px window, on a screen with a way back.
const Window = styled.div`
    width: ${({theme}) => theme.sizes.window.width};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.lg};
    overflow: hidden;
    background: ${({theme}) => theme.colors.bg};
`

function Strip({platform, back}: { platform: Platform, back: boolean }) {
    const [onTop, setOnTop] = useState(false)
    return (
        <Window>
            <TitleBar
                platform={platform}
                title={back ? 'Settings' : 'Protocol'}
                onBack={back ? () => undefined : undefined}
                onTop={onTop}
                onTopChange={setOnTop}
            />
        </Window>
    )
}

const meta = {
    title: 'Shell/TitleBar',
    component: Strip,
    args: {platform: 'windows', back: true},
    argTypes: {
        platform: {control: 'inline-radio', options: ['macos', 'windows', 'linux']},
    },
} satisfies Meta<typeof Strip>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** macOS draws the traffic lights itself; the strip leaves room for them. */
export const MacOS: Story = {args: {platform: 'macos'}, globals: {theme: 'light'}}

/** GNOME's round close and the screen's title in the middle. */
export const Linux: Story = {args: {platform: 'linux'}, globals: {theme: 'dark'}}

/** The meetings: no way back. */
export const Home: Story = {args: {back: false}, globals: {theme: 'light'}}
