import type {Meta, StoryObj} from '@storybook/react-vite'
import {MemoryRouter} from 'react-router-dom'
import {mockState} from '@/mocks/state'
import {beginRecovery, deleteRecovery, RECOVERY_SETTLE_MS, setRecoveryFolder, storeRecoveryLine} from '../api/recovery'
import {reset} from '../test/stories'
import {RecoverySheet} from './RecoverySheet'

const SCRIPT = [
    ['You', 'Let’s look at the onboarding copy first.'],
    ['Speaker 2', 'The headline is too long for the narrow window.'],
    ['You', 'Then we cut the second sentence.'],
] as const

// Two meetings an earlier session left unsaved, one with audio checkpoints.
// The browser's own IndexedDB holds them, so each run writes them again.
async function interrupted() {
    await reset()
    const start = Date.now() - 3 * 60 * 60 * 1000
    for (const [meetingId, title, folder] of [
        ['meeting-story-1', 'Onboarding copy review', '/recordings/onboarding'],
        ['meeting-story-2', 'Meeting, Tue, Nov 24, 4:10 PM', null],
    ] as const) {
        await deleteRecovery(meetingId)
        await beginRecovery({meetingId, title, startTime: start})
        if (folder) {
            await setRecoveryFolder(meetingId, folder)
            mockState.live.checkpoints[folder] = true
        }
        for (const [index, [source, text]] of SCRIPT.entries()) {
            await storeRecoveryLine(meetingId, {
                text, source, timestamp: '16:10:00', sequence_id: index + 1, chunk_start_time: index * 4, is_partial: false,
                confidence: 0.9, audio_start_time: index * 4, audio_end_time: index * 4 + 3, duration: 3,
            })
        }
    }
    // Offered only once a copy has stood still.
    await new Promise((resolve) => setTimeout(resolve, RECOVERY_SETTLE_MS + 100))
}

const meta = {
    title: 'Recording/RecoverySheet',
    component: RecoverySheet,
    decorators: [(Story) => <MemoryRouter><Story/></MemoryRouter>],
    beforeEach: interrupted,
} satisfies Meta<typeof RecoverySheet>

export default meta

type Story = StoryObj<typeof meta>

/** Recover saves one into the sample library; Delete asks first. */
export const InterruptedMeetings: Story = {}

export const InterruptedMeetingsDark: Story = {globals: {theme: 'dark'}}
