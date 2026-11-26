import {QueryClientProvider, useQuery} from '@tanstack/react-query'
import {renderHook, waitFor} from '@testing-library/react'
import {beforeEach, describe, expect, it} from 'vitest'
import {meetingQuery, meetingsQuery, renameMeeting, startSummary} from '@/api/meetings'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {useSummaryTitleSync} from './summaryTitleSync'

const MEETING = 'meeting-untitled'

/** The shell's sync with a screen that shows the list and the meeting. */
function mount() {
    const client = createTestQueryClient()
    return renderHook(() => {
        useSummaryTitleSync()
        const list = useQuery(meetingsQuery).data?.find((meeting) => meeting.id === MEETING)?.title
        const open = useQuery(meetingQuery(MEETING)).data?.title
        return {list, open}
    }, {wrapper: ({children}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>})
}

const summarize = () => startSummary({meetingId: MEETING, provider: 'ollama', model: 'llama3.2'})

beforeEach(() => {
    mockState.meetings.summaryRunMs = 0
})

describe('useSummaryTitleSync', () => {
    it('shows the title a summary gave a meeting whose title the app made', async () => {
        const {result} = mount()
        await waitFor(() => expect(result.current.list).toMatch(/^Meeting, /))

        await summarize()

        await waitFor(() => expect(result.current.list).toMatch(/^About /))
        expect(result.current.open).toBe(result.current.list)
    })

    it('keeps a title the user set, through a summary written again', async () => {
        await renameMeeting(MEETING, 'Hiring sync')
        const {result} = mount()
        await waitFor(() => expect(result.current.list).toBe('Hiring sync'))

        await summarize()

        await waitFor(() => expect(mockState.meetings.summaries[MEETING]?.status).toBe('completed'))
        await summarize()
        await waitFor(() => expect(mockState.meetings.summaries[MEETING]?.status).toBe('completed'))
        expect(result.current).toEqual({list: 'Hiring sync', open: 'Hiring sync'})
    })
})
