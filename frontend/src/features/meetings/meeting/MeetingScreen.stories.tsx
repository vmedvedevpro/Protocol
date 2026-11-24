import type {Meta, StoryObj} from '@storybook/react-vite'
import {postCallJobs} from '@/api/postCall'
import {mockState} from '@/mocks/state'
import {StoryWindow} from '../StoryWindow'
import {MeetingRoute} from './MeetingScreen'

function MeetingDemo({meetingId, tab}: { meetingId: string, tab: 'notes' | 'transcript' | 'summary' }) {
    return <StoryWindow url={`/meetings/${meetingId}?tab=${tab}`} path="/meetings/:meetingId" element={<MeetingRoute/>}/>
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
