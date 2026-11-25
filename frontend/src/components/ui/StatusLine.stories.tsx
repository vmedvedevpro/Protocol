import {useEffect, useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {MotionConfig} from 'motion/react'
import styled from 'styled-components'
import {SegmentedControl} from './SegmentedControl'
import {type Status, StatusLine} from './StatusLine'

const Column = styled.div`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[4]};
`

const MEANINGS = [
    {value: 'checking', label: 'Checking'},
    {value: 'downloading', label: 'Downloading'},
    {value: 'ready', label: 'Ready'},
    {value: 'up-to-date', label: 'Up to date'},
] as const

type Meaning = (typeof MEANINGS)[number]['value']

// The bottom bar's update line. Picking another meaning swaps the line;
// while checking, a spinner turns before it (a wait of unknown length);
// while downloading, the percent climbs in place beside it.
function Updates({initial = 'downloading'}: { initial?: Meaning }) {
    const [meaning, setMeaning] = useState<Meaning>(initial)
    const [percent, setPercent] = useState(40)
    useEffect(() => {
        if (meaning !== 'downloading') return
        const timer = setInterval(() => setPercent((value) => (value >= 99 ? 0 : value + 3)), 400)
        return () => clearInterval(timer)
    }, [meaning])

    const status: Status = {
        checking: {key: 'checking', text: 'Checking for updates…', busy: true},
        downloading: {key: 'downloading', text: 'Downloading 0.7.0…', value: `${percent}%`},
        ready: {key: 'ready', text: 'Update 0.7.0 is ready'},
        // Checking → Up to date is where a value used to arrive beside the
        // leaving text and jump: now it comes in with its own text.
        'up-to-date': {key: 'up-to-date', text: 'Up to date, checked', value: 'just now'},
    }[meaning]

    return (
        <Column>
            <SegmentedControl label="Update state" options={MEANINGS} value={meaning} onChange={setMeaning}/>
            <StatusLine status={status}/>
        </Column>
    )
}

const meta = {
    title: 'UI/StatusLine',
    component: Updates,
} satisfies Meta<typeof Updates>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Checking for updates: a wait of unknown length, so the spinner turns before the text. */
export const Checking: Story = {globals: {theme: 'light'}, args: {initial: 'checking'}}

/** Reduced motion: lines swap with a fade, without moving; the spinner still turns. */
export const ReducedMotion: Story = {
    globals: {theme: 'light'},
    args: {initial: 'checking'},
    decorators: [(Story) => <MotionConfig reducedMotion="always"><Story/></MotionConfig>],
}
