import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {MotionConfig} from 'motion/react'
import {SegmentedControl} from './SegmentedControl'

const RANGES = [
    {value: 'day', label: 'Day'},
    {value: 'week', label: 'Week'},
    {value: 'month', label: 'Month'},
    {value: 'all', label: 'All time'},
] as const

type Range = (typeof RANGES)[number]['value']

function Ranges() {
    const [value, setValue] = useState<Range>('week')
    return <SegmentedControl label="Range" options={RANGES} value={value} onChange={setValue}/>
}

const meta = {
    title: 'UI/SegmentedControl',
    component: Ranges,
} satisfies Meta<typeof Ranges>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** What reduced motion looks like: the thumb jumps, colours still fade. */
export const ReducedMotion: Story = {
    globals: {theme: 'light'},
    decorators: [(Story) => <MotionConfig reducedMotion="always"><Story/></MotionConfig>],
}
