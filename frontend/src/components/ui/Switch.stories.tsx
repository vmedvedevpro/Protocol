import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {MotionConfig} from 'motion/react'
import styled from 'styled-components'
import {Switch} from './Switch'

const Row = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
`

function Switches() {
    const [advanced, setAdvanced] = useState(false)
    const [saveAudio, setSaveAudio] = useState(true)
    return (
        <Row>
            <Switch label="Advanced settings" checked={advanced} onCheckedChange={setAdvanced}/>
            <Switch label="Save audio" checked={saveAudio} onCheckedChange={setSaveAudio}/>
            <Switch label="Unavailable" checked={false} onCheckedChange={() => {}} disabled/>
        </Row>
    )
}

const meta = {
    title: 'UI/Switch',
    component: Switches,
} satisfies Meta<typeof Switches>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Reduced motion: the knob jumps, the track's colour still fades. */
export const ReducedMotion: Story = {
    globals: {theme: 'light'},
    decorators: [(Story) => <MotionConfig reducedMotion="always"><Story/></MotionConfig>],
}
