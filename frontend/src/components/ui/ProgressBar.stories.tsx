import {useEffect, useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {ProgressBar} from './ProgressBar'

const Column = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[4]};
    width: 240px;
`

// A download that climbs a step at a time, as on first launch, next to a
// still one and a finished one.
function Bars() {
    const [percent, setPercent] = useState(64)
    useEffect(() => {
        const timer = setInterval(() => setPercent((value) => (value >= 100 ? 0 : value + 4)), 500)
        return () => clearInterval(timer)
    }, [])
    return (
        <Column>
            <ProgressBar label="Downloading Parakeet" value={percent}/>
            <ProgressBar label="Whisper Large V3 Turbo, queued" value={0}/>
            <ProgressBar label="Gemma 3 4B" value={100}/>
        </Column>
    )
}

const meta = {
    title: 'UI/ProgressBar',
    component: Bars,
} satisfies Meta<typeof Bars>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
