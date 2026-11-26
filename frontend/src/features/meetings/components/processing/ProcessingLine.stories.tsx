import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {ProcessingLine} from './ProcessingLine'
import {STORY_MEETING, type StoryPass, useStoryPass} from './storyPass'

// Home's row: the title over this line.
const Row = styled.div`
    display: flex;
    flex-direction: column;
    width: 300px;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.surface};
`

const Title = styled.span`
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

function ProcessingLineDemo(pass: StoryPass) {
    useStoryPass(pass)
    return (
        <Row>
            <Title>Acme pilot security review</Title>
            <ProcessingLine meetingId={STORY_MEETING}/>
        </Row>
    )
}

const meta = {
    title: 'Processing/ProcessingLine',
    component: ProcessingLineDemo,
    args: {state: 'running', step: 'transcript', percent: 40},
    argTypes: {
        state: {control: 'inline-radio', options: ['queued', 'running', 'cancelling', 'failed']},
        step: {control: 'inline-radio', options: ['transcript', 'speakers', 'summary']},
    },
} satisfies Meta<typeof ProcessingLineDemo>

export default meta

type Story = StoryObj<typeof meta>

/** "Improving the transcript (about 2 min)", as Home's row shows it. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

export const Playing: Story = {args: {percent: 0, play: true}}

export const Failed: Story = {args: {state: 'failed'}}
