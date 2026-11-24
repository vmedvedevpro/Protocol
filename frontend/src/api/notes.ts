/**
 * The user's own notes for a meeting, written during or after the call
 * (src-tauri/src/database/repositories/meeting_notes.rs). They are stored
 * twice: as Markdown, which search, export and AI agents read, and as the
 * BlockNote document, which keeps the formatting exact. Summary generation
 * never writes them.
 */
import {mutationOptions, queryOptions} from '@tanstack/react-query'
import {command} from './core'

/** Mirrors `MeetingNotes` in meeting_notes.rs. */
export interface MeetingNotes {
    /** Absent when the notes were saved blank. */
    markdown?: string
    /**
     * The BlockNote blocks. Absent when only Markdown was saved, or when the
     * stored JSON no longer parses.
     */
    json?: unknown[]
    /** SQLite `datetime('now')`: UTC, as `2026-11-24 09:30:00`. */
    updatedAt: string
}

/** What a save sends: the editor's Markdown and its BlockNote blocks. */
export interface NotesDraft {
    markdown: string | null
    json: unknown[] | null
}

export const notesKeys = {
    all: ['notes'] as const,
    meeting: (meetingId: string) => [...notesKeys.all, 'meeting', meetingId] as const,
}

/** The meeting's notes, or null when none were ever saved. */
export function getMeetingNotes(meetingId: string): Promise<MeetingNotes | null> {
    return command('api_get_meeting_notes', {meetingId})
}

/**
 * Replaces the meeting's notes. Native stores blank Markdown and a null
 * document as absent, and rejects a meeting it does not know with
 * "Meeting not found".
 */
export function saveMeetingNotes(meetingId: string, notes: NotesDraft): Promise<null> {
    return command('api_save_meeting_notes', {meetingId, markdown: notes.markdown, json: notes.json})
}

export const meetingNotesQuery = (meetingId: string) =>
    queryOptions({
        queryKey: notesKeys.meeting(meetingId),
        queryFn: () => getMeetingNotes(meetingId),
    })

/**
 * Saves one meeting's notes. Saves of a meeting share a scope, so they reach
 * native one at a time in the order they were made: two autosaves in flight
 * at once could land out of order and leave the older text stored.
 */
export const saveMeetingNotesMutation = (meetingId: string) =>
    mutationOptions({
        mutationFn: (notes: NotesDraft) => saveMeetingNotes(meetingId, notes),
        scope: {id: `notes:${meetingId}`},
        onSuccess: (_saved, _notes, _result, {client}) =>
            client.invalidateQueries({queryKey: notesKeys.meeting(meetingId)}),
    })
