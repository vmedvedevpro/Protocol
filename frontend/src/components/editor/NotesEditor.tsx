import {lazy, Suspense} from 'react'
import styled from 'styled-components'
import {loadNotesEditor} from './loadNotesEditor'
import type {NotesEditorProps} from './types'

const NotesEditorView = lazy(loadNotesEditor)

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
