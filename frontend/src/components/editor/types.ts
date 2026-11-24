import type {Block} from '@blocknote/core'

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
    autoFocus?: boolean
    /** Every edit; the loaded content does not count as one. */
    onChange?: (content: NotesContent) => void
    /** The initial content is in the editor. */
    onReady?: () => void
}
