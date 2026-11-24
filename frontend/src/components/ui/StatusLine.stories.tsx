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
] as const

type Meaning = (typeof MEANINGS)[number]['value']

// The bottom bar's update line. Picking another meaning swaps the line;
// while downloading, the percent climbs in place beside it.
function Updates() {
    const [meaning, setMeaning] = useState<Meaning>('downloading')
    const [percent, setPercent] = useState(40)
    useEffect(() => {
        if (meaning !== 'downloading') return
        const timer = setInterval(() => setPercent((value) => (value >= 99 ? 0 : value + 3)), 400)
        return () => clearInterval(timer)
    }, [meaning])

    const status: Status = {
        checking: {key: 'checking', text: 'Checking for updates…'},
        downloading: {key: 'downloading', text: 'Downloading 0.7.0…', value: `${percent}%`},
        ready: {key: 'ready', text: 'Update 0.7.0 is ready'},
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

/** Reduced motion: lines swap with a fade, without moving. */
export const ReducedMotion: Story = {
    globals: {theme: 'light'},
    decorators: [(Story) => <MotionConfig reducedMotion="always"><Story/></MotionConfig>],
}
