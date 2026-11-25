import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {Button} from './Button'
import {Spinner} from './Spinner'

const Column = styled.div`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[4]};
`

const Small = styled.p`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Notes = styled.p`
    ${({theme}) => theme.text.notes};
    color: ${({theme}) => theme.colors.muted};
`

// Sized to the text it waits beside, in its colour; a delayed one holds back
// before it fades in, as the notes editor's does while its chunk loads.
function Spinners() {
    const [run, setRun] = useState(0)
    return (
        <Column>
            <Small><Spinner/>Checking for updates…</Small>
            <Notes><Spinner/></Notes>
            <Notes key={run}><Spinner delayed/></Notes>
            <Button size="sm" onClick={() => setRun(run + 1)}>Replay the delayed one</Button>
        </Column>
    )
}

const meta = {
    title: 'UI/Spinner',
    component: Spinners,
} satisfies Meta<typeof Spinners>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
