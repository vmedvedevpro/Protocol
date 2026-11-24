import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {Ring} from '@/components/ring/Ring'
import {Button} from '@/components/ui/Button'
import {Kbd} from '@/components/ui/Kbd'
import {formatShortcut} from '@/lib/platform'
import {DockedBar} from './DockedBar'

const Window = styled.div`
    width: ${({theme}) => theme.sizes.window.width};
    border-top: 1px solid ${({theme}) => theme.colors.border};
    background: ${({theme}) => theme.colors.bg};
`

const Status = styled.span`
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

const Timer = styled.span`
    font-family: ${({theme}) => theme.fonts.mono};
    ${({theme}) => theme.text.timer};
    font-variant-numeric: tabular-nums;
`

const Line = styled.span`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

// The layout as the design fills it; the recording (#112) brings the data.
function Bar({recording}: { recording: boolean }) {
    return (
        <Window>
            {recording ? (
                <DockedBar
                    label="Recording"
                    ring={<Ring mode="rec" size={56} level={{kind: 'recording', source: 'both'}}/>}
                    action={<Button trailing={<Kbd>{formatShortcut('R')}</Kbd>}>Stop</Button>}
                >
                    <Timer>12:04</Timer>
                    <Line>Headset + all apps</Line>
                </DockedBar>
            ) : (
                <DockedBar
                    label="Record"
                    ring={<Ring mode="idle" size={56}/>}
                    action={<Button variant="filled" trailing={<Kbd tone="fill">{formatShortcut('R')}</Kbd>}>Record</Button>}
                >
                    <Status>Ready to record</Status>
                    <Line>Headset + all apps</Line>
                </DockedBar>
            )}
        </Window>
    )
}

const meta = {
    title: 'Recording/DockedBar',
    component: Bar,
    args: {recording: false},
} satisfies Meta<typeof Bar>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

export const Recording: Story = {args: {recording: true}, globals: {theme: 'light'}}
