import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {ProcessingSteps} from './ProcessingSteps'
import {STORY_MEETING, type StoryPass, useStoryPass} from './storyPass'

// The Summary tab's width inside the 460 px window.
const Column = styled.div`
    width: 420px;
`

function ProcessingStepsDemo(pass: StoryPass) {
    useStoryPass(pass)
    return (
        <Column>
            <ProcessingSteps meetingId={STORY_MEETING}/>
        </Column>
    )
}

const meta = {
    title: 'Processing/ProcessingSteps',
    component: ProcessingStepsDemo,
    args: {state: 'running', step: 'transcript', percent: 40},
    argTypes: {
        state: {control: 'inline-radio', options: ['queued', 'running', 'cancelling', 'failed']},
        step: {control: 'inline-radio', options: ['transcript', 'speakers', 'summary']},
        percent: {control: {type: 'range', min: 0, max: 100, step: 1}},
    },
} satisfies Meta<typeof ProcessingStepsDemo>

export default meta

type Story = StoryObj<typeof meta>

/** As the design draws it: saved, the transcript improving with the time left, two to go. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Each step's icon swaps as the pass moves on. */
export const Playing: Story = {args: {percent: 0, play: true}}

/** Finding speakers failed; the strip above offers Retry and Skip. */
export const Failed: Story = {args: {state: 'failed', step: 'speakers', percent: undefined}}

/** Saved without audio and without the automatic summary: speakers only. */
export const SpeakersOnly: Story = {args: {step: 'speakers', percent: undefined, noAudio: true, noSummary: true}}
