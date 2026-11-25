import type {Meta, StoryObj} from '@storybook/react-vite'
import {DEFAULT_LABS, useLabsStore} from '@/api/labs'
import {postCallJobs} from '@/api/postCall'
import {StoryWindow} from '@/components/screen/StoryWindow'
import {mockState} from '@/mocks/state'
import {meetingsStoryRoutes} from '../storyRoutes'

function MeetingDemo({meetingId, tab}: { meetingId: string, tab: 'notes' | 'transcript' | 'summary' }) {
    return <StoryWindow url={`/meetings/${meetingId}?tab=${tab}`} routes={meetingsStoryRoutes()}/>
}

const meta = {
    title: 'Meetings/MeetingScreen',
    component: MeetingDemo,
    args: {meetingId: 'meeting-acme-review', tab: 'summary'},
    argTypes: {tab: {control: 'inline-radio', options: ['notes', 'transcript', 'summary']}},
} satisfies Meta<typeof MeetingDemo>

export default meta

type Story = StoryObj<typeof meta>

/** The summary, editable, its action items under it; the player docked below. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** The transcript in turns; a time plays from there, "3 speakers" finds them again. */
export const Transcript: Story = {args: {tab: 'transcript'}}

export const Notes: Story = {args: {tab: 'notes'}}

/** Labs on: the waveform behind the scrubber, 0.5× and 0.75×, and Clean or Verbatim text. */
export const WithLabs: Story = {
    args: {tab: 'transcript'},
    beforeEach: () => {
        useLabsStore.setState({value: {...DEFAULT_LABS, transcriptScrubbing: true, cleanTranscript: true}})
        return () => useLabsStore.setState({value: DEFAULT_LABS})
    },
}

export const WithLabsDark: Story = {...WithLabs, globals: {theme: 'dark'}}

/** No summary yet: Generate summary writes one (about 2.5 s on the mock). */
export const NoSummary: Story = {args: {meetingId: 'meeting-untitled'}}

/** A run that failed: what native said, and Try again. */
export const SummaryFailed: Story = {
    args: {meetingId: 'meeting-untitled'},
    beforeEach: () => {
        mockState.meetings.summaries['meeting-untitled'] = {
            status: 'failed', data: null, error: 'The summary model ran out of memory.', userEdited: false, start: null, end: null,
        }
    },
}

/** Just recorded: the pass's status under the header, its steps where the summary will be. */
export const Processing: Story = {
    beforeEach: () => {
        postCallJobs.queue('meeting-acme-review', ['transcript', 'speakers', 'summary'])
        postCallJobs.run('meeting-acme-review', 'transcript')
        postCallJobs.progress('meeting-acme-review', 25, Date.now() - 40_000)
        postCallJobs.progress('meeting-acme-review', 40)
        return () => postCallJobs.reset()
    },
}
