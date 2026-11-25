import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import type {AudioSource} from '@/api/audio'
import type {LevelWarning} from '@/components/ring/levelAdvice'
import {type MinibarPhase, MinibarPill} from './MinibarPill'

// The minibar's window: the pill sits at its left edge and opens rightwards.
const Window = styled.div`
    display: flex;
    align-items: center;
    width: ${({theme}) => theme.sizes.minibar.width};
    height: ${({theme}) => theme.sizes.minibar.height};
`

interface DemoProps {
    phase: MinibarPhase
    micMuted: boolean
    systemMuted: boolean
    open: boolean
    failure: string | null
    warning: LevelWarning | null
}

// The pill with local state in native's place: the ring pauses, a source
// mutes. The page (MinibarPage) does the same through native commands.
function MinibarDemo({phase: initialPhase, micMuted, systemMuted, open, failure, warning}: DemoProps) {
    const [phase, setPhase] = useState(initialPhase)
    const [muted, setMuted] = useState<Record<AudioSource, boolean>>({mic: micMuted, system: systemMuted})
    return (
        <Window>
            <MinibarPill
                phase={phase}
                seconds={12 * 60 + 4}
                muted={muted}
                warning={warning}
                failure={failure}
                open={open}
                onTogglePause={() => setPhase(phase === 'paused' ? 'recording' : 'paused')}
                onToggleMute={(source) => setMuted({...muted, [source]: !muted[source]})}
                onStop={() => setPhase('finishing')}
                onBackToWindow={() => undefined}
                onDragStart={() => undefined}
            />
        </Window>
    )
}

const meta = {
    title: 'Recording/Minibar',
    component: MinibarDemo,
    args: {phase: 'recording', micMuted: false, systemMuted: false, open: false, failure: null, warning: null},
    argTypes: {
        phase: {control: 'inline-radio', options: ['recording', 'paused', 'finishing']},
        warning: {control: 'inline-radio', options: [null, 'loud', 'quiet']},
    },
} satisfies Meta<typeof MinibarDemo>

export default meta

type Story = StoryObj<typeof meta>

/** Small by default: the ring, the timer, Stop. Hover or Tab opens the rest. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Open: the sources with their levels (a click mutes), Pause, Back to the full window. */
export const Open: Story = {args: {open: true}}

export const OpenDark: Story = {args: {open: true, systemMuted: true}, globals: {theme: 'dark'}}

/** Paused with the microphone muted: "Muted" on the inverted fill, no hue. */
export const PausedMicMuted: Story = {args: {open: true, phase: 'paused', micMuted: true}}

/** After Stop, until native closes the bar: the timer holds, a spinner stands where Stop was. */
export const Finishing: Story = {args: {phase: 'finishing'}}

/** A command that failed says so in the status's place for a while. */
export const Failure: Story = {args: {failure: 'Could not pause'}}

/** Computer audio too loud: the warning icon and outline on its button. */
export const LoudSystemAudio: Story = {args: {open: true, warning: 'loud'}}
