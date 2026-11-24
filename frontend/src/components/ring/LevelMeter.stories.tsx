import type {Meta, StoryObj} from '@storybook/react-vite'
import {type LevelFeed, useAudioLevelMonitoring} from '@/api/audio'
import {LevelMeter} from './LevelMeter'
import {useMockLevel} from './storyLevels'

interface LevelMeterDemoProps {
    /** A source of the recording, or a device of the preview. */
    feed: 'mic' | 'system' | 'input device' | 'output device'
    /** The preview's volume slider; the meter shows the level it would give. */
    gain: number
    /** Holds the fake audio at this level, 0 to 1; unset plays a fake conversation. */
    level?: number
}

function feedOf({feed, gain}: LevelMeterDemoProps): LevelFeed {
    if (feed === 'mic' || feed === 'system') return {kind: 'recording', source: feed}
    return {kind: 'device', type: feed === 'input device' ? 'input' : 'output', gain}
}

function LevelMeterDemo(props: LevelMeterDemoProps) {
    const preview = props.feed === 'input device' || props.feed === 'output device'
    useMockLevel(props.level)
    useAudioLevelMonitoring(preview ? [] : null)
    return <LevelMeter level={feedOf(props)} label="Audio level"/>
}

const meta = {
    title: 'Ring/LevelMeter',
    component: LevelMeterDemo,
    args: {feed: 'mic', gain: 1},
    argTypes: {
        feed: {control: 'inline-radio', options: ['mic', 'system', 'input device', 'output device']},
        gain: {control: {type: 'range', min: 0, max: 2, step: 0.05}},
        level: {control: {type: 'range', min: 0, max: 1, step: 0.01}},
    },
} satisfies Meta<typeof LevelMeterDemo>

export default meta

type Story = StoryObj<typeof meta>

/** The bars alone, in the current text colour. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** A device preview beside its volume slider: drag `gain` and the meter follows at once. */
export const PreviewGain: Story = {args: {feed: 'input device', gain: 0.5, level: 0.6}}
