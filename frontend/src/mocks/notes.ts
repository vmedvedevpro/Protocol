import type {MeetingNotes} from '@/api/notes'
import type {MockHandler} from './handlers'

/** `meeting_notes` rows by meeting id. */
export type NotesByMeeting = Record<string, MeetingNotes>

/**
 * Notes as the old app saved them, BlockNote 0.36 JSON next to its Markdown,
 * on the meeting the design shows ("Acme pilot security review" in the old
 * preview's fixtures). Every block carries the props 0.36 wrote, so loading
 * them checks that the editor still reads that format.
 */
export const SAMPLE_NOTES_BLOCKS = [
    {
        id: '0b6f3d4e-5a8c-4c1e-9d2f-1a7b8c9d0e11',
        type: 'bulletListItem',
        props: {textColor: 'default', backgroundColor: 'default', textAlignment: 'left'},
        content: [{type: 'text', text: 'Legal wants it in writing: nothing leaves the laptop', styles: {}}],
        children: [],
    },
    {
        id: '1c7a4e5f-6b9d-4d2f-8e3a-2b8c9d0e1f22',
        type: 'bulletListItem',
        props: {textColor: 'default', backgroundColor: 'default', textAlignment: 'left'},
        content: [
            {type: 'text', text: 'Pilot group gets local models only, ', styles: {}},
            {type: 'text', text: 'Priya by Friday', styles: {bold: true}},
        ],
        children: [],
    },
    {
        id: '2d8b5f6a-7cae-4e3a-9f4b-3c9d0e1f2a33',
        type: 'bulletListItem',
        props: {textColor: 'default', backgroundColor: 'default', textAlignment: 'left'},
        content: [{type: 'text', text: 'Retention statement for the rollout doc: who writes it?', styles: {}}],
        children: [],
    },
    {
        id: '3e9c6a7b-8dbf-4f4b-8a5c-4d0e1f2a3b44',
        type: 'heading',
        props: {textColor: 'default', backgroundColor: 'default', textAlignment: 'left', level: 2, isToggleable: false},
        content: [{type: 'text', text: 'Follow-ups', styles: {}}],
        children: [],
    },
    {
        id: '4fad7b8c-9ec0-4a5c-9b6d-5e1f2a3b4c55',
        type: 'checkListItem',
        props: {textColor: 'default', backgroundColor: 'default', textAlignment: 'left', checked: false},
        content: [{type: 'text', text: 'Draft the retention statement', styles: {}}],
        children: [],
    },
    {
        id: '5abe8c9d-afd1-4b6d-8c7e-6f2a3b4c5d66',
        type: 'checkListItem',
        props: {textColor: 'default', backgroundColor: 'default', textAlignment: 'left', checked: true},
        content: [{type: 'text', text: 'Share the pilot device list', styles: {}}],
        children: [],
    },
]

export const SAMPLE_NOTES_MARKDOWN = `* Legal wants it in writing: nothing leaves the laptop
* Pilot group gets local models only, **Priya by Friday**
* Retention statement for the rollout doc: who writes it?

## Follow-ups

* [ ] Draft the retention statement
* [x] Share the pilot device list
`

/** Notes saved as Markdown only, with no BlockNote document next to them. */
export const SAMPLE_MARKDOWN_ONLY_NOTES = `# Q4 roadmap

1. Ship summaries that run on the laptop
2. Calendar import after the pilot
`

export function createMockNotes(): NotesByMeeting {
    return {
        'meeting-acme-review': {
            markdown: SAMPLE_NOTES_MARKDOWN,
            json: structuredClone(SAMPLE_NOTES_BLOCKS),
            updatedAt: '2026-11-24 09:52:10',
        },
        'meeting-roadmap': {
            markdown: SAMPLE_MARKDOWN_ONLY_NOTES,
            updatedAt: '2026-11-23 15:40:02',
        },
    }
}

/** SQLite `datetime('now')`, which native stamps on every save. */
const sqliteNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

/**
 * The handlers of src-tauri/src/database/repositories/meeting_notes.rs,
 * spread into `handlers` with the mock state. Native also rejects a meeting
 * that does not exist ("Meeting not found"); the mock keeps no meeting list
 * to check against.
 */
export function notesHandlers(state: {meetingNotes: NotesByMeeting}): Record<string, MockHandler> {
    return {
        api_get_meeting_notes: ({meetingId}) => state.meetingNotes[String(meetingId)] ?? null,
        api_save_meeting_notes: ({meetingId, markdown, json}) => {
            if (meetingId === undefined) {
                throw 'invalid args `meetingId` for command `api_save_meeting_notes`: command api_save_meeting_notes missing required key meetingId'
            }
            // As native stores them: blank Markdown and a null document become absent.
            const notes: MeetingNotes = {updatedAt: sqliteNow()}
            if (typeof markdown === 'string' && markdown.trim()) notes.markdown = markdown
            if (json !== null && json !== undefined) notes.json = json as unknown[]
            state.meetingNotes[String(meetingId)] = notes
            return null
        },
    }
}
