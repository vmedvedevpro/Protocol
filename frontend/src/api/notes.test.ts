import type {QueryClient} from '@tanstack/react-query'
import {describe, expect, it, vi} from 'vitest'
import {handlers, type MockArgs} from '@/mocks/handlers'
import {SAMPLE_MARKDOWN_ONLY_NOTES, SAMPLE_NOTES_BLOCKS, SAMPLE_NOTES_MARKDOWN} from '@/mocks/notes'
import {mockState} from '@/mocks/state'
import {settleIpc} from '@/test/ipc'
import {createTestQueryClient} from '@/test/queryClient'
import {meetingNotesQuery, type NotesDraft, notesKeys, saveMeetingNotesMutation} from './notes'

function save(client: QueryClient, meetingId: string, draft: NotesDraft) {
    return client.getMutationCache().build(client, saveMeetingNotesMutation(meetingId)).execute(draft)
}

describe('meeting notes', () => {
    it('reads both stored forms, or null for a meeting without notes', async () => {
        const client = createTestQueryClient()

        const saved = await client.fetchQuery(meetingNotesQuery('meeting-acme-review'))
        const markdownOnly = await client.fetchQuery(meetingNotesQuery('meeting-roadmap'))
        const none = await client.fetchQuery(meetingNotesQuery('meeting-1on1'))

        expect(saved).toMatchObject({markdown: SAMPLE_NOTES_MARKDOWN, json: SAMPLE_NOTES_BLOCKS})
        expect(markdownOnly).toEqual({markdown: SAMPLE_MARKDOWN_ONLY_NOTES, updatedAt: expect.any(String)})
        expect(none).toBeNull()
    })

    it('saves both forms and marks the cached notes stale', async () => {
        const client = createTestQueryClient()
        await client.fetchQuery(meetingNotesQuery('meeting-1on1'))
        const json = [{type: 'paragraph', content: 'Ask about the budget'}]

        await save(client, 'meeting-1on1', {markdown: 'Ask about the budget\n', json})

        expect(client.getQueryState(notesKeys.meeting('meeting-1on1'))?.isInvalidated).toBe(true)
        expect(await client.fetchQuery(meetingNotesQuery('meeting-1on1'))).toMatchObject({
            markdown: 'Ask about the budget\n',
            json,
        })
    })

    it('stores blank notes as absent, as native does', async () => {
        const client = createTestQueryClient()

        await save(client, 'meeting-acme-review', {markdown: '  \n', json: null})

        expect(mockState.meetingNotes['meeting-acme-review']).toEqual({updatedAt: expect.any(String)})
    })

    it('sends the saves of a meeting one at a time, in order', async () => {
        const client = createTestQueryClient()
        const store = handlers.api_save_meeting_notes
        // The first save answers a macrotask later than the second, which the
        // mock answers on microtasks; sent at once, the older text would land last.
        vi.spyOn(handlers, 'api_save_meeting_notes').mockImplementation(async (args: MockArgs) => {
            if (args.markdown === 'older') await settleIpc()
            return store(args)
        })

        await Promise.all([
            save(client, 'meeting-1on1', {markdown: 'older', json: null}),
            save(client, 'meeting-1on1', {markdown: 'newer', json: null}),
        ])

        expect(mockState.meetingNotes['meeting-1on1'].markdown).toBe('newer')
    })
})
