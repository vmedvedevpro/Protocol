import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {ProcessingStatus} from './ProcessingStatus'
import {STORY_MEETING, type StoryPass, useStoryPass} from './storyPass'

// The meeting screen's width inside the 460 px window.
const Column = styled.div`
    width: 428px;
`

function ProcessingStatusDemo(pass: StoryPass) {
    useStoryPass(pass)
    return (
        <Column>
            <ProcessingStatus meetingId={STORY_MEETING}/>
        </Column>
    )
}

const meta = {
    title: 'Processing/ProcessingStatus',
    component: ProcessingStatusDemo,
    args: {state: 'running', step: 'transcript', percent: 40},
    argTypes: {
        state: {control: 'inline-radio', options: ['queued', 'running', 'cancelling', 'failed']},
        step: {control: 'inline-radio', options: ['transcript', 'speakers', 'summary']},
        percent: {control: {type: 'range', min: 0, max: 100, step: 1}},
    },
} satisfies Meta<typeof ProcessingStatusDemo>

export default meta

type Story = StoryObj<typeof meta>

/** The transcript step 40 % in, with the time left; Cancel stops the pass. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** The whole pass, moving by itself: each step swaps the line, the bar climbs. */
export const Playing: Story = {args: {percent: 0, play: true}}

/** Speakers have no percent: no time left, the bar counts the steps. */
export const FindingSpeakers: Story = {args: {step: 'speakers', percent: undefined}}

/** Another meeting's pass holds the speech model. */
export const Queued: Story = {args: {state: 'queued'}}

/** Retry runs the step again; Keep live transcript goes on with speakers. */
export const Failed: Story = {args: {state: 'failed'}}

export const FailedDark: Story = {globals: {theme: 'dark'}, args: {state: 'failed'}}
