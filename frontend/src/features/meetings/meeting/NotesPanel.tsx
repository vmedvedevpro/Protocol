import {useState} from 'react'
import {useMutation, useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {meetingNotesQuery, saveMeetingNotesMutation} from '@/api/notes'
import {NotesEditor} from '@/components/editor/NotesEditor'
import {Spinner} from '@/components/ui/Spinner'
import {toast} from '@/components/ui/toastStore'
import {useAutosave, useSaving} from '../lib/autosave'

const Panel = styled.div`
    height: 100%;
    overflow-y: auto;
    padding: ${({theme}) => theme.space[3.5]} ${({theme}) => theme.space[5]} ${({theme}) => theme.space[4]};
`

const Problem = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.muted};
`

/**
 * The user's notes for the meeting, in the notes editor; edits save
 * themselves a moment after typing stops, and at once when the tab or the
 * screen closes. The editor reads its content once, when it mounts, so it
 * mounts only after the last save of these notes has landed and been read
 * back: a save still in flight (the user typed, switched tabs and came
 * straight back) would otherwise leave it on the older cached text.
 */
export function NotesPanel({meetingId}: { meetingId: string }) {
    const notes = useQuery(meetingNotesQuery(meetingId))
    const saving = useSaving(`notes:${meetingId}`)
    // The error toast is the mutation's own: the last edit is saved as the
    // panel unmounts, and mutate()'s callbacks die with it.
    const save = useMutation({
        ...saveMeetingNotesMutation(meetingId),
        onError: (error) => toast.error('Couldn’t save your notes', {description: error.message}),
    })
    const autosave = useAutosave((content: { markdown: string, json: unknown[] }) => {
        const blank = !content.markdown.trim()
        save.mutate({markdown: blank ? null : content.markdown, json: blank ? null : content.json})
    })

    // Once the editor is up it stays: its own saves must not unmount it.
    const [mounted, setMounted] = useState(false)
    const fresh = notes.isSuccess && !notes.isFetching && !saving
    if (fresh && !mounted) setMounted(true)

    return (
        <Panel>
            {notes.isError && !mounted && <Problem role="alert">Couldn’t load your notes: {notes.error.message}</Problem>}
            {!mounted && !notes.isError && <Problem aria-busy="true"><Spinner delayed/></Problem>}
            {mounted && (
                <NotesEditor
                    label="Notes"
                    placeholder="Write notes about this meeting…"
                    initialBlocks={notes.data?.json ?? null}
                    initialMarkdown={notes.data?.markdown ?? null}
                    onChange={autosave.schedule}
                />
            )}
        </Panel>
    )
}
