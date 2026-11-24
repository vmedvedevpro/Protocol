import {QueryClientProvider} from '@tanstack/react-query'
import {act, screen} from '@testing-library/react'
import {beforeAll, describe, expect, it, vi} from 'vitest'
import {meetingNotesQuery, saveMeetingNotesMutation} from '@/api/notes'
import {handlers} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {settleIpc} from '@/test/ipc'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'
import {NotesPanel} from './NotesPanel'

describe('NotesPanel', () => {
    // The editor is a lazy chunk; see NotesEditor.test.tsx.
    beforeAll(async () => {
        await import('@/components/editor/NotesEditorView')
    })

    it('shows the saved notes in the editor', async () => {
        renderUi(<QueryClientProvider client={createTestQueryClient()}><NotesPanel meetingId="meeting-roadmap"/></QueryClientProvider>)
        expect(await screen.findByRole('textbox', {name: 'Notes'})).toBeInTheDocument()
    })

    it('waits for a save still in flight before it mounts the editor, then shows the saved text', async () => {
        const client = createTestQueryClient()
        // The cache holds the notes from before the edit.
        await client.fetchQuery(meetingNotesQuery('meeting-roadmap'))
        let land = () => {}
        const save = handlers.api_save_meeting_notes
        vi.spyOn(handlers, 'api_save_meeting_notes').mockImplementation((args) => new Promise((resolve) => {
            land = () => resolve(save(args))
        }))
        // An edit made before the tab was left, still on its way.
        void client.getMutationCache()
            .build(client, saveMeetingNotesMutation('meeting-roadmap'))
            .execute({markdown: '# Saved just now', json: null})
        await settleIpc()

        renderUi(<QueryClientProvider client={client}><NotesPanel meetingId="meeting-roadmap"/></QueryClientProvider>)
        // Long enough for the notes to be read again and the editor to mount, were it not waiting.
        await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
        expect(screen.queryByRole('textbox', {name: 'Notes'})).not.toBeInTheDocument()

        land()
        const notes = await screen.findByRole('textbox', {name: 'Notes'})
        expect(notes).toHaveTextContent('Saved just now')
        expect(mockState.meetingNotes['meeting-roadmap']?.markdown).toBe('# Saved just now')
    })
})
