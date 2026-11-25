import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import type {AudioSource} from '@/api/audio'
import type {LevelWarning} from './levelAdvice'
import {SourceMeter} from './SourceMeter'
import {useMockLevel} from './storyLevels'

interface SourceMeterDemoProps {
    source: AudioSource
    muted: boolean
    /** The recording is paused: the bars rest. */
    paused: boolean
    /** Holds the fake audio at this level, 0 to 1; unset plays a fake conversation. */
    level?: number
    /** Level advice on computer audio (`useSystemAudioWarning`). */
    warning?: LevelWarning | null
}

// The button is the caller's toggle; here a click flips local state, as the
// recording bar would after set_microphone_muted.
function SourceMeterDemo({source, muted: initiallyMuted, paused, level, warning = null}: SourceMeterDemoProps) {
    const [muted, setMuted] = useState(initiallyMuted)
    useMockLevel(level)
    return (
        <SourceMeter
            source={source}
            muted={muted}
            level={paused ? null : {kind: 'recording', source}}
            warning={warning}
            onToggle={() => setMuted(!muted)}
        />
    )
}

const meta = {
    title: 'Ring/SourceMeter',
    component: SourceMeterDemo,
    // A new `muted` from Controls starts the demo over in that state.
    render: (args) => <SourceMeterDemo key={String(args.muted)} {...args}/>,
    args: {source: 'mic', muted: false, paused: false},
    argTypes: {
        source: {control: 'inline-radio', options: ['mic', 'system']},
        level: {control: {type: 'range', min: 0, max: 1, step: 0.01}},
        warning: {control: 'inline-radio', options: [null, 'loud', 'quiet']},
    },
} satisfies Meta<typeof SourceMeterDemo>

export default meta

type Story = StoryObj<typeof meta>

/** Click to mute; the bars give way to "Muted" on an inverted fill. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

export const ComputerAudio: Story = {args: {source: 'system'}}

export const Muted: Story = {args: {muted: true}}

export const MutedDark: Story = {globals: {theme: 'dark'}, args: {muted: true}}

/** A paused recording: nothing to hear, the bars rest. */
export const Paused: Story = {args: {paused: true}}

/** Drag `level` in Controls; clear it to go back to the fake conversation. */
/** Computer audio the limiter keeps clipping: a warning icon and an outline; the tooltip says what to do. */
export const TooLoud: Story = {args: {source: 'system', warning: 'loud', level: 0.95}}

export const TooLoudDark: Story = {globals: {theme: 'dark'}, args: {source: 'system', warning: 'loud', level: 0.95}}

/** Computer audio that stays very quiet. */
export const LowAudio: Story = {args: {source: 'system', warning: 'quiet', level: 0.05}}

export const LevelSlider: Story = {args: {level: 0.6}}

const Bar = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
`

function Pair() {
    return (
        <Bar>
            <SourceMeterDemo source="mic" muted={false} paused={false}/>
            <SourceMeterDemo source="system" muted={false} paused={false}/>
        </Bar>
    )
}

/** Both sources as the minibar shows them: they take turns. */
export const BothSources: Story = {render: () => <Pair/>}

export const BothSourcesDark: Story = {globals: {theme: 'dark'}, render: () => <Pair/>}
