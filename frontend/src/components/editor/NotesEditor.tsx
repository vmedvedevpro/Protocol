import {lazy, Suspense} from 'react'
import type {Block} from '@blocknote/core'
import styled from 'styled-components'

/**
 * What an edit reports: the BlockNote blocks, the exact copy, and their
 * Markdown, which search, export and AI agents read. A save stores both
 * (`saveMeetingNotes` in src/api/notes.ts).
 */
export interface NotesContent {
    json: Block[]
    markdown: string
}

export interface NotesEditorProps {
    /**
     * The stored BlockNote blocks (`MeetingNotes.json`). Read once, when the
     * editor mounts; to show other notes, remount it with a new `key`.
     */
    initialBlocks?: unknown[] | null
    /**
     * The stored Markdown, read when there are no blocks or they cannot be
     * read. Also returned as the Markdown if an edit cannot be converted.
     */
    initialMarkdown?: string | null
    /** Shown while the notes are empty. */
    placeholder?: string
    /** Names the text box for assistive technology. */
    label?: string
    editable?: boolean
    /** Puts the caret in the notes once they are loaded. Read once, like the content. */
    autoFocus?: boolean
    /** Every edit; the loaded content does not count as one. */
    onChange?: (content: NotesContent) => void
    /** The initial content is in the editor. */
    onReady?: () => void
}

const NotesEditorView = lazy(() => import('./NotesEditorView'))

/**
 * The editor of a meeting's notes, on BlockNote. BlockNote is its own chunk,
 * so the first screen with notes downloads it; the space stays empty until
 * it arrives, then the notes fade in.
 */
export function NotesEditor(props: NotesEditorProps) {
    return (
        <Suspense fallback={<Pending aria-busy="true"/>}>
            <NotesEditorView {...props}/>
        </Suspense>
    )
}

// Holds the editor's place, so the panel does not change height when it loads.
const Pending = styled.div`
    min-height: 100%;
`
