/**
 * The notes typed during a recording. They live in the session (the editor
 * mounts from there, so switching tabs never mounts it from an older copy)
 * and are copied to localStorage (`af-live-notes`), so a reload of the
 * window during the same recording keeps them. The next start clears them;
 * the save after Stop puts them on the meeting.
 */
import type {NotesContent} from '@/components/editor/NotesEditor'
import {session} from './session'

const NOTES_KEY = 'af-live-notes'

// Typing changes the notes on every key; the copy is written at most this often.
const WRITE_DELAY_MS = 500

let pending: ReturnType<typeof setTimeout> | null = null

function write() {
    pending = null
    const {notes} = session.get()
    try {
        if (notes) localStorage.setItem(NOTES_KEY, JSON.stringify({...notes, updatedAt: Date.now()}))
        else localStorage.removeItem(NOTES_KEY)
    } catch {
        // The copy is best effort: the session still holds the notes.
    }
}

/** An edit in the editor. */
export function setLiveNotes(notes: NotesContent) {
    session.set({notes})
    if (pending === null) pending = setTimeout(write, WRITE_DELAY_MS)
}

/** Writes a waiting copy now: before a save reads the notes, and when the window hides. */
export function flushLiveNotes() {
    if (pending === null) return
    clearTimeout(pending)
    write()
}

/** The notes a reload left in storage, for the recording still running. */
export function restoreLiveNotes() {
    try {
        const stored = localStorage.getItem(NOTES_KEY)
        if (!stored) return
        const notes = JSON.parse(stored) as Partial<NotesContent>
        if (typeof notes.markdown === 'string') {
            session.set({notes: {markdown: notes.markdown, json: Array.isArray(notes.json) ? notes.json : []}})
        }
    } catch {
        // Unreadable notes are dropped, as the old UI did.
    }
}

/** A new recording starts with an empty page; a saved one leaves none behind. */
export function clearLiveNotes() {
    if (pending !== null) clearTimeout(pending)
    pending = null
    session.set({notes: null})
    try {
        localStorage.removeItem(NOTES_KEY)
    } catch {
        // Nothing to clear without storage.
    }
}
