import {describe, expect, it, vi} from 'vitest'
import {getActionItems} from '@/api/actionItems'
import {handlers} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {backfillActionItems, hasActionSection, syncFinishedSummary} from './actionItemSync'

const markdownOf = (meetingId: string) => (mockState.meetings.summaries[meetingId].data as { markdown: string }).markdown

describe('syncFinishedSummary', () => {
    it('moves the action section into rows once, keeping the untrimmed text', async () => {
        expect(hasActionSection(mockState.meetings.summaries['meeting-acme-review'].data)).toBe(true)
        const [first, second] = await Promise.all([syncFinishedSummary('meeting-acme-review'), syncFinishedSummary('meeting-acme-review')])
        expect(first).toBe(second)
        expect(first.changed).toBe(true)

        expect(markdownOf('meeting-acme-review')).not.toContain('## Action items')
        expect(mockState.meetings.summaries['meeting-acme-review'].data).toMatchObject({original_markdown: expect.stringContaining('## Action items')})
        const items = await getActionItems({meetingId: 'meeting-acme-review'})
        expect(items.map((item) => item.ownerLabel)).toContain('Priya Shah')

        // Read again: the section is gone, so nothing changes.
        expect(await syncFinishedSummary('meeting-acme-review')).toEqual({changed: false})
        expect(await getActionItems({meetingId: 'meeting-acme-review'})).toHaveLength(items.length)
    })

    it('leaves a summary the user edited alone', async () => {
        mockState.meetings.summaries['meeting-acme-review'].userEdited = true
        expect(await syncFinishedSummary('meeting-acme-review')).toEqual({changed: false})
        expect(markdownOf('meeting-acme-review')).toContain('## Action items')
    })
})

describe('backfillActionItems', () => {
    it('reads the old summaries once per session', async () => {
        sessionStorage.clear()
        expect(await backfillActionItems()).toBeGreaterThan(0)
        expect(markdownOf('meeting-acme-review')).not.toContain('## Action items')
        expect(await backfillActionItems()).toBe(0)
    })

    it('runs again after a list call that failed', async () => {
        sessionStorage.clear()
        vi.spyOn(handlers, 'api_list_unsynced_action_meetings').mockImplementationOnce(() => {
            throw 'database is locked'
        })
        expect(await backfillActionItems()).toBe(0)

        expect(await backfillActionItems()).toBeGreaterThan(0)
    })
})
