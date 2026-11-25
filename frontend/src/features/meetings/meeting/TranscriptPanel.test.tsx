import {act, screen} from '@testing-library/react'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {postCallJobs} from '@/api/postCall'
import {renderRoute} from '../testing'
import {TranscriptPanel} from './TranscriptPanel'

// The list's props, render by render: the turns are memoised on them.
const seen = vi.hoisted(() => ({speakerActions: [] as unknown[]}))
vi.mock('@/components/transcript/TranscriptList', async (original) => {
    const actual = await original<typeof import('@/components/transcript/TranscriptList')>()
    return {
        ...actual,
        TranscriptList: (props: { speakerActions?: unknown }) => {
            seen.speakerActions.push(props.speakerActions)
            return <p>Transcript</p>
        },
    }
})

const MEETING = 'meeting-acme-review'

describe('TranscriptPanel', () => {
    afterEach(() => {
        postCallJobs.reset()
        seen.speakerActions = []
    })

    it('keeps the speaker actions while a pass ticks, so every turn keeps its memo', async () => {
        renderRoute(`/meetings/${MEETING}`, [{path: '/meetings/:meetingId', element: <TranscriptPanel meetingId={MEETING} playing={false}/>}])
        await screen.findByText('Transcript')
        act(() => {
            postCallJobs.queue(MEETING, ['transcript'])
            postCallJobs.run(MEETING, 'transcript')
        })
        const running = seen.speakerActions.at(-1)

        act(() => postCallJobs.progress(MEETING, 10))
        act(() => postCallJobs.progress(MEETING, 20))

        expect(seen.speakerActions.at(-1)).toBe(running)
    })
})
