import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {MotionConfig} from 'motion/react'
import styled from 'styled-components'
import {SegmentedControl, TabList, TabPanels, Tabs} from './SegmentedControl'

const RANGES = [
    {value: 'day', label: 'Day'},
    {value: 'week', label: 'Week'},
    {value: 'month', label: 'Month'},
    {value: 'all', label: 'All time'},
] as const

type Range = (typeof RANGES)[number]['value']

const VIEWS = [
    {value: 'notes', label: 'Notes'},
    {value: 'transcript', label: 'Transcript'},
    {value: 'summary', label: 'Summary'},
] as const

type View = (typeof VIEWS)[number]['value']

const TEXT: Record<View, string> = {
    notes: 'Pilot scope: two teams, local models only. Legal wants the retention statement in writing.',
    transcript: 'Speaker 2, 03:18 — Appreciate it. Our main concern is still where the audio ends up.',
    summary: 'Decisions: ship a config that only shows local models. Open question: who writes the retention statement?',
}

const Board = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[6]};
    width: 428px;
`

const Meeting = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3]};
    height: 120px;
`

const Paragraph = styled.p`
    color: ${({theme}) => theme.colors.soft};
`

// The theme-like segments of a settings row, and the meeting views over
// their panels, as on the Panel artboard.
function Segments() {
    const [range, setRange] = useState<Range>('week')
    const [view, setView] = useState<View>('notes')
    return (
        <Board>
            <SegmentedControl label="Range" options={RANGES} value={range} onChange={setRange}/>
            <Tabs label="Meeting views" options={VIEWS} value={view} onChange={setView}>
                <Meeting>
                    <TabList/>
                    <TabPanels<View>>{(shown) => <Paragraph>{TEXT[shown]}</Paragraph>}</TabPanels>
                </Meeting>
            </Tabs>
        </Board>
    )
}

const meta = {
    title: 'UI/SegmentedControl',
    component: Segments,
} satisfies Meta<typeof Segments>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** What reduced motion looks like: the thumb jumps, colours and panels still fade. */
export const ReducedMotion: Story = {
    globals: {theme: 'light'},
    decorators: [(Story) => <MotionConfig reducedMotion="always"><Story/></MotionConfig>],
}
