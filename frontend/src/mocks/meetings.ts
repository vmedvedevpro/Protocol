import {emit} from '@tauri-apps/api/event'
import type {ActionItem, ActionItemDraft} from '@/api/actionItems'
import {
    type Folder,
    type MeetingListItem,
    type MeetingMetadata,
    SUMMARY_PROGRESS_EVENT,
    type SummaryProgress,
    type SummaryResponse,
    type SummaryStatus,
    type TranscriptSegment,
} from '@/api/meetings'
import type {MockHandler} from './handlers'

/**
 * The sample library: meetings, folders, transcripts, summaries and action
 * items, ported from the old browser preview
 * (`162e8be:frontend/src/dev/preview/fixtures.ts` and its handlers in
 * `index.ts`). Dates are relative to the moment the mock loads, so the list
 * always looks current.
 */

const DAY = 86_400_000

function at(daysAgo: number, hour: number, minute = 0): string {
    const date = new Date(Date.now() - daysAgo * DAY)
    date.setHours(hour, minute, 0, 0)
    return date.toISOString()
}

/** Days back to the most recent `weekday` (0 = Sunday), counting today. */
function lastWeekday(weekday: number): number {
    return (new Date().getDay() - weekday + 7) % 7
}

const short = (iso: string) => new Date(iso).toLocaleDateString('en-US', {month: 'short', day: 'numeric'})

function long(iso: string): string {
    const date = new Date(iso)
    const day = date.toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric'})
    const time = date.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'})
    return `${day} · ${time}`
}

/** A `meetings` row as native keeps it. */
export interface MockMeeting {
    id: string
    title: string
    created_at: string
    group_id: string | null
    folder_path: string | null
}

/** A `summary_processes` row: the run's status and the stored summary. */
export interface MockSummary {
    status: SummaryStatus
    data: unknown
    error: string | null
    userEdited: boolean
    start: string | null
    end: string | null
}

type FolderRow = Omit<Folder, 'meetingCount' | 'lastMeetingAt' | 'lastMeetingId' | 'lastMeetingTitle'>

// Last week's Thursday when today is one, so the newest sample is always today's Acme review.
const thursday = lastWeekday(4) || 7

function sampleMeetings(): MockMeeting[] {
    const standup = (weeksAgo: number, minute: number): MockMeeting => ({
        id: `meeting-standup-${weeksAgo}`,
        title: `Weekly Standup — ${short(at(thursday + weeksAgo * 7, 12))}`,
        created_at: at(thursday + weeksAgo * 7, 12, minute),
        group_id: 'group-standup',
        folder_path: `/preview/standup-${weeksAgo}`,
    })
    return [
        {id: 'meeting-acme-review', title: 'Acme pilot security review', created_at: at(0, 9, 30), group_id: 'group-acme', folder_path: '/preview/acme-review'},
        {id: 'meeting-roadmap', title: 'Q4 roadmap planning', created_at: at(1, 15, 5), group_id: null, folder_path: '/preview/roadmap'},
        {id: 'meeting-design-crit', title: 'Onboarding flow critique', created_at: at(2, 11, 0), group_id: 'group-design', folder_path: '/preview/design-crit'},
        standup(0, 2),
        standup(1, 1),
        {id: 'meeting-untitled', title: `Meeting · ${long(at(9, 16, 40))}`, created_at: at(9, 16, 40), group_id: null, folder_path: '/preview/untitled'},
        {id: 'meeting-acme-kickoff', title: 'Acme pilot kickoff', created_at: at(11, 10, 0), group_id: 'group-acme', folder_path: '/preview/acme-kickoff'},
        standup(2, 3),
        {id: 'meeting-1on1', title: '1:1 with Priya', created_at: at(16, 14, 0), group_id: null, folder_path: '/preview/1on1'},
        standup(3, 0),
        standup(4, 4),
        {id: 'meeting-design-sync', title: 'Design system sync', created_at: at(34, 13, 30), group_id: 'group-design', folder_path: '/preview/design-sync'},
    ]
}

/** How long each sample meeting ran, in seconds; the lines spread over it. */
const LENGTHS: Record<string, number> = {
    'meeting-acme-review': 2_710,
    'meeting-roadmap': 3_420,
    'meeting-design-crit': 1_980,
    'meeting-untitled': 640,
    'meeting-acme-kickoff': 3_060,
    'meeting-1on1': 1_800,
    'meeting-design-sync': 2_400,
}

function sampleFolders(): FolderRow[] {
    const createdAt = new Date(Date.now() - 60 * DAY).toISOString()
    return [
        {id: 'group-standup', name: 'Weekly Standup', color: 'blue', kind: 'recurring', description: 'Engineering sync. Blockers first.', createdAt},
        {id: 'group-acme', name: 'Acme Corp', color: 'orange', kind: 'customer', description: 'Enterprise pilot.', createdAt},
        {id: 'group-design', name: 'Design Team', color: 'violet', kind: 'team', createdAt},
    ]
}

/** Who spoke in which meeting, besides you. */
const SPEAKERS: Record<string, string[]> = {
    'meeting-design-crit': ['Elena García', 'Priya Shah'],
    'meeting-acme-kickoff': ['Tom Becker'],
    'meeting-1on1': ['Priya Shah'],
    'meeting-design-sync': ['Elena García'],
    'meeting-standup-0': ['Marcus Lee', 'Priya Shah'],
    'meeting-standup-1': ['Marcus Lee'],
    'meeting-standup-2': ['Marcus Lee', 'Priya Shah'],
    'meeting-standup-3': ['Marcus Lee', 'Elena García'],
    'meeting-standup-4': ['Marcus Lee', 'Priya Shah'],
}

const ACME_REVIEW_LINES: [string, string][] = [
    ['You', 'Thanks for making time, everyone. The goal today is to close out the open items from the security questionnaire.'],
    ['Tom Becker', 'Appreciate it. Our main concern is still where the audio ends up. Legal wants it in writing that nothing leaves the laptop.'],
    ['You', 'That part is simple. Recording, transcription and summaries all run locally. Nothing is uploaded unless someone picks a cloud model on purpose.'],
    ['Sam Rivera', 'Can we disable the cloud providers for the whole pilot group?'],
    ['Priya Shah', 'Yes. We can ship a config that only shows local models. I can have that ready by Friday.'],
    ['Tom Becker', 'Good. The second item was SSO. Is that a blocker for the pilot?'],
    ['You', 'Not for the pilot. It is a desktop app with no accounts, so there is nothing to sign in to.'],
    ['Sam Rivera', 'Then the only procurement question left is the support agreement.'],
    ['Priya Shah', 'I will send over the draft support terms after this call.'],
    ['Tom Becker', 'Let us target the pilot start for the first week of next month. Twenty seats to begin with.'],
    ['You', 'That works. I will set up a check-in two weeks after launch to review feedback.'],
    ['Sam Rivera', 'One more thing: we need a data retention statement for the recordings folder.'],
    ['You', 'Recordings stay in a folder you choose. You can delete them any time. I will write that up in the rollout doc.'],
    ['Tom Becker', 'Perfect. I think that covers it from our side.'],
    ['Priya Shah', 'Great. I will circulate notes and the action items by end of day.'],
]

const ROADMAP_LINES: [string, string][] = [
    ['Priya Shah', 'Let us start with the three themes for Q4: speed, reliability, and making the app feel like one product.'],
    ['Marcus Lee', 'On speed, the biggest win is still loading long transcripts. Pagination helped but search needs to jump to the right line.'],
    ['You', 'Agreed. Search should land you on the exact moment, and ideally play the audio from there.'],
    ['Priya Shah', 'That ties into the audio player work. Marcus, can you scope that this week?'],
    ['Marcus Lee', 'Yes. I will have an estimate by Wednesday.'],
    ['You', 'For reliability, the post-call pipeline still fails silently when the model is missing.'],
    ['Marcus Lee', 'We should surface that in the meeting header instead of a toast that disappears.'],
    ['Priya Shah', 'Decision: errors that block a meeting get a persistent banner, not a toast.'],
    ['You', 'I will take the design for the banner and share it Thursday.'],
    ['Priya Shah', 'Last topic, groups. Customers want to see every meeting with one account in one place.'],
    ['Marcus Lee', 'Groups with colors in the sidebar would cover most of that.'],
    ['You', 'Let us plan the groups work for the second half of the quarter.'],
]

function linesFor(meetingId: string): [string, string][] {
    if (meetingId === 'meeting-acme-review') return ACME_REVIEW_LINES
    if (meetingId === 'meeting-roadmap') return ROADMAP_LINES
    // A meeting nobody named a voice in keeps the diarizer's labels.
    const speakers = SPEAKERS[meetingId] ?? ['Speaker 1', 'Speaker 2']
    const other = speakers[0]
    return [
        ['You', 'Quick round of updates. What is everyone working on?'],
        [other, 'I finished the review of last week’s changes and I am moving on to the release checklist.'],
        ['You', 'Any blockers?'],
        [other, 'Only waiting on test data from the platform team.'],
        ['You', 'I will follow up with them today.'],
        [speakers[1] ?? other, 'I can help with that if needed.'],
    ]
}

/** Seconds a meeting ran: its own length, or the standup's. */
const lengthOf = (meetingId: string) => LENGTHS[meetingId] ?? (meetingId.startsWith('meeting-standup') ? 1_200 : 600)

/**
 * The lines are excerpts spread over the whole meeting, so the list, the
 * header and the player agree on how long it ran.
 */
export function sampleTranscript(meetingId: string, lines = linesFor(meetingId), length = lengthOf(meetingId)): TranscriptSegment[] {
    const durations = lines.map(([, text]) => Math.max(3, Math.round(text.split(' ').length / 2.6)))
    const spoken = durations.reduce((sum, duration) => sum + duration, 0)
    const gap = Math.max(1.5, Math.round((length - 8 - spoken) / Math.max(1, lines.length - 1)))
    let cursor = 4
    return lines.map(([speaker, text], index) => {
        const duration = durations[index]
        const start = cursor
        cursor += duration + gap
        return {
            id: `${meetingId}-t${index}`,
            text,
            speaker,
            timestamp: '09:30:00',
            audio_start_time: start,
            audio_end_time: start + duration,
            duration,
        }
    })
}

const ACME_SUMMARY = `## Summary

The team closed the remaining items from Acme’s security questionnaire. Acme confirmed that local-only processing satisfies their legal requirement, SSO is not required for the pilot, and the pilot will start with twenty seats in the first week of next month.

## Decisions

- Pilot ships with cloud providers hidden; only local models are available.
- SSO is out of scope for the pilot.
- Pilot starts the first week of next month with 20 seats.

## Action items

| Owner | Task | Due |
| --- | --- | --- |
| Priya Shah | Prepare a local-models-only configuration for the pilot group | Friday |
| Priya Shah | Send draft support terms to Acme | Today |
| You | Write the data retention statement in the rollout doc | Next week |
| You | Schedule a feedback check-in two weeks after launch | |

## Open questions

- Who at Acme signs off on the support agreement?
`

const ROADMAP_SUMMARY = `## Summary

Q4 planning centred on three themes: speed, reliability, and making the app feel like one product.

## Decisions

- Errors that block a meeting get a persistent banner instead of a toast.
- Groups work is planned for the second half of the quarter.

## Action items

- Marcus Lee: scope the audio player work and share an estimate by Wednesday
- You: design the persistent error banner and share it Thursday
`

const STANDUP_SUMMARY = `## Summary

Round of updates. Release checklist is in progress; the only blocker is test data from the platform team.

## Action items

- You: follow up with the platform team about test data today
`

/**
 * Summaries as native stores them, in each of its formats: Markdown in an
 * object, a double-encoded string, and the older map of titled sections.
 */
function sampleSummaries(meetings: MockMeeting[]): Record<string, MockSummary> {
    const done = (data: unknown): MockSummary => ({status: 'completed', data, error: null, userEdited: false, start: null, end: null})
    const summaries: Record<string, MockSummary> = {
        'meeting-acme-review': done({markdown: ACME_SUMMARY}),
        'meeting-roadmap': done(JSON.stringify({markdown: ROADMAP_SUMMARY})),
        'meeting-design-sync': done({
            _section_order: ['overview', 'next'],
            overview: {title: 'Overview', blocks: [{id: 'b1', type: 'text', content: 'Tokens move to one file per theme.', color: 'default'}]},
            next: {title: 'Next steps', blocks: [{id: 'b2', type: 'bullet', content: 'Elena publishes the icon set.', color: 'default'}]},
        }),
    }
    for (const meeting of meetings) {
        if (!summaries[meeting.id] && meeting.id !== 'meeting-untitled') summaries[meeting.id] = done({markdown: STANDUP_SUMMARY})
    }
    return summaries
}

export function createMockMeetings() {
    const meetings = sampleMeetings()
    return {
        meetings,
        folders: sampleFolders(),
        transcripts: Object.fromEntries(meetings.map((meeting) => [meeting.id, sampleTranscript(meeting.id)])) as Record<string, TranscriptSegment[]>,
        summaries: sampleSummaries(meetings),
        actionItems: [] as ActionItem[],
        /** Meetings whose summary was read for action items, by the fingerprint of that summary. */
        actionSources: {} as Record<string, string>,
        /** `metadata.json` values: the chosen and the detected summary language. */
        summaryLanguages: {} as Record<string, string | null>,
        detectedLanguages: {} as Record<string, string | null>,
        /** Whether a speaker engine is installed. */
        diarizationAvailable: true,
        /** How long a mock summary run takes, in ms. */
        summaryRunMs: 2_500,
        /** Folders opened with `open_meeting_folder`, in order. */
        openedFolders: [] as string[],
    }
}

export type MockMeetings = ReturnType<typeof createMockMeetings>

let nextId = 0
const newId = (prefix: string) => `${prefix}-mock-${(nextId++).toString(36)}`
const now = () => new Date().toISOString()

function required<T>(value: T | undefined, name: string, command: string): T {
    if (value === undefined) throw `invalid args \`${name}\` for command \`${command}\`: command ${command} missing required key ${name}`
    return value
}

/** As `GroupListItem`: the row with its meeting count and latest meeting. */
function folderView(db: MockMeetings, folder: FolderRow): Folder {
    const filed = db.meetings.filter((meeting) => meeting.group_id === folder.id).sort((a, b) => b.created_at.localeCompare(a.created_at))
    const last = filed[0]
    const view: Folder = {...folder, meetingCount: filed.length, createdAt: folder.createdAt}
    if (last) Object.assign(view, {lastMeetingAt: last.created_at, lastMeetingId: last.id, lastMeetingTitle: last.title})
    return view
}

function durationOf(db: MockMeetings, meetingId: string): number | undefined {
    const lines = db.transcripts[meetingId] ?? []
    return lines.length ? Math.max(...lines.map((line) => line.audio_end_time ?? line.audio_start_time ?? 0)) : undefined
}

function meetingOf(db: MockMeetings, meetingId: unknown): MockMeeting {
    const meeting = db.meetings.find((entry) => entry.id === meetingId)
    if (!meeting) throw `Meeting not found: ${String(meetingId)}`
    return meeting
}

function actionView(db: MockMeetings, item: ActionItem): ActionItem {
    const meeting = db.meetings.find((entry) => entry.id === item.meetingId)
    const view = {...item, meetingTitle: meeting?.title ?? 'Meeting', meetingCreatedAt: meeting?.created_at ?? item.createdAt}
    if (meeting?.group_id) view.groupId = meeting.group_id
    else delete view.groupId
    return view
}

function newActionItem(meetingId: string, draft: ActionItemDraft, source: 'ai' | 'user', position: number): ActionItem {
    const stamp = now()
    const item: ActionItem = {
        id: newId('action'),
        meetingId,
        meetingTitle: '',
        meetingCreatedAt: stamp,
        text: draft.text,
        done: false,
        source,
        edited: source === 'user',
        position,
        createdAt: stamp,
        updatedAt: stamp,
    }
    if (draft.ownerLabel) item.ownerLabel = draft.ownerLabel
    if (draft.dueText) item.dueText = draft.dueText
    if (typeof draft.audioTime === 'number') item.audioTime = draft.audioTime
    if (draft.transcriptId) item.transcriptId = draft.transcriptId
    return item
}

/** A summary the mock writes for a run: the meeting's lines, owned by who said them. */
function writtenSummary(db: MockMeetings, meetingId: string, customPrompt: string): string {
    const lines = db.transcripts[meetingId] ?? []
    const points = lines.slice(0, 3).map((line) => `- ${line.text}`)
    return [
        '## Summary',
        '',
        `A ${Math.max(1, Math.round((durationOf(db, meetingId) ?? 60) / 60))}-minute conversation${customPrompt ? ` (${customPrompt})` : ''}.`,
        '',
        '## Decisions',
        '',
        ...points,
        '',
        '## Open questions',
        '',
        '- What happens next?',
        '',
    ].join('\n')
}

/**
 * The handlers of the meetings domain: api.rs, group.rs, action_item.rs,
 * summary/commands.rs and the speaker labels of diarization/mod.rs (its
 * `diarize_meeting` is in ./postCall.ts, with the pass after a call). They
 * read `state.meetings` each time, so `resetMockState()` swaps the whole
 * library; a summary run still going then writes into the old one.
 */
export function meetingsHandlers(state: { meetings: MockMeetings }): Record<string, MockHandler> {
    /** Starts a mock summary run: progress events, then the new summary or a failure. */
    function runSummary(db: MockMeetings, meetingId: string, customPrompt: string): string {
        const processId = newId('process')
        const previous = db.summaries[meetingId]
        db.summaries[meetingId] = {
            status: 'processing',
            data: previous?.data ?? null,
            error: null,
            userEdited: previous?.userEdited ?? false,
            start: now(),
            end: null,
        }
        const emitProgress = (stage: SummaryProgress['stage'], message: string, data: unknown = null) => {
            // After a reset the run belongs to a library nobody shows; tests
            // may also have taken the IPC down by then.
            if (state.meetings !== db) return
            const progress: SummaryProgress = {meetingId, processId, stage, message, data}
            emit(SUMMARY_PROGRESS_EVENT, progress).catch(() => undefined)
        }
        emitProgress('preparing', 'Preparing transcript…')
        setTimeout(() => {
            const run = db.summaries[meetingId]
            if (run?.status !== 'processing') return
            run.status = 'summarizing'
            emitProgress('generating', 'Writing the summary…')
        }, db.summaryRunMs / 2)
        setTimeout(() => {
            const run = db.summaries[meetingId]
            if (run?.status !== 'summarizing') return
            const data = {markdown: writtenSummary(db, meetingId, customPrompt)}
            Object.assign(run, {status: 'completed', data, userEdited: false, end: now()})
            emitProgress('completed', 'Summary ready', data)
        }, db.summaryRunMs)
        return processId
    }

    return {
        // ---- api.rs
        api_get_meetings: (): MeetingListItem[] =>
            [...state.meetings.meetings]
                .sort((a, b) => b.created_at.localeCompare(a.created_at))
                .map((meeting) => {
                    const item: MeetingListItem = {id: meeting.id, title: meeting.title, created_at: meeting.created_at}
                    const duration = durationOf(state.meetings, meeting.id)
                    if (duration !== undefined) item.duration_seconds = duration
                    if (meeting.group_id) item.group_id = meeting.group_id
                    return item
                }),
        api_get_meeting_metadata: ({meetingId}): MeetingMetadata => {
            const meeting = meetingOf(state.meetings, meetingId)
            const metadata: MeetingMetadata = {id: meeting.id, title: meeting.title, created_at: meeting.created_at, updated_at: meeting.created_at}
            if (meeting.folder_path) metadata.folder_path = meeting.folder_path
            return metadata
        },
        api_get_meeting_transcripts: ({meetingId, limit, offset}) => {
            const lines = state.meetings.transcripts[String(meetingId)] ?? []
            const from = Number(offset ?? 0)
            const count = Number(required(limit, 'limit', 'api_get_meeting_transcripts'))
            // A negative LIMIT is SQLite's "no limit".
            const page = count < 0 ? lines.slice(from) : lines.slice(from, from + count)
            return {transcripts: page, total_count: lines.length, has_more: from + page.length < lines.length}
        },
        api_save_transcript: ({meetingTitle, transcripts, folderPath, recordingStartedAt}) => {
            const id = newId('meeting')
            const lines = (required(transcripts, 'transcripts', 'api_save_transcript') as TranscriptSegment[]).map((line) => ({...line}))
            state.meetings.meetings.push({
                id,
                title: String(required(meetingTitle, 'meetingTitle', 'api_save_transcript')),
                created_at: typeof recordingStartedAt === 'string' ? new Date(recordingStartedAt).toISOString() : now(),
                group_id: null,
                folder_path: typeof folderPath === 'string' ? folderPath : null,
            })
            state.meetings.transcripts[id] = lines
            return {status: 'success', message: 'Transcript saved successfully', meeting_id: id}
        },
        api_save_meeting_title: ({meetingId, title}) => {
            const meeting = state.meetings.meetings.find((entry) => entry.id === meetingId)
            if (!meeting) throw `No meeting found with id ${String(meetingId)}`
            meeting.title = String(required(title, 'title', 'api_save_meeting_title'))
            return {message: 'Meeting title saved successfully'}
        },
        api_delete_meeting: ({meetingId}) => {
            const db = state.meetings
            if (!db.meetings.some((entry) => entry.id === meetingId)) throw `Meeting not found or could not be deleted: ${String(meetingId)}`
            db.meetings = db.meetings.filter((entry) => entry.id !== meetingId)
            db.actionItems = db.actionItems.filter((item) => item.meetingId !== meetingId)
            delete db.transcripts[String(meetingId)]
            delete db.summaries[String(meetingId)]
            return {status: 'success', message: 'Meeting deleted successfully'}
        },
        api_get_meeting_audio: ({meetingId}) => {
            const meeting = state.meetings.meetings.find((entry) => entry.id === meetingId)
            const playable = !!meeting?.folder_path && (state.meetings.transcripts[meeting.id]?.length ?? 0) > 0
            return playable
                ? {path: `${MOCK_AUDIO_PREFIX}${meeting.id}`, micPath: null, systemPath: null}
                : {path: null, micPath: null, systemPath: null}
        },
        open_meeting_folder: ({meetingId}) => {
            const meeting = meetingOf(state.meetings, meetingId)
            if (!meeting.folder_path) throw 'Meeting has no recording folder'
            state.meetings.openedFolders.push(meeting.folder_path)
            return null
        },
        // ---- database/repositories/group.rs
        api_list_groups: () =>
            state.meetings.folders
                .map((folder) => folderView(state.meetings, folder))
                .sort((a, b) => (b.lastMeetingAt ?? '').localeCompare(a.lastMeetingAt ?? '')),
        api_create_group: ({name}) => {
            const trimmed = String(required(name, 'name', 'api_create_group')).trim()
            if (!trimmed) throw 'Group name is required'
            if (state.meetings.folders.some((folder) => folder.name.toLowerCase() === trimmed.toLowerCase())) {
                throw 'A group with this name already exists'
            }
            const folder: FolderRow = {id: newId('group'), name: trimmed, createdAt: now()}
            state.meetings.folders.push(folder)
            return folderView(state.meetings, folder)
        },
        api_update_group: ({groupId, name, color, kind, description, schedule}) => {
            const folder = state.meetings.folders.find((entry) => entry.id === groupId)
            if (!folder) throw 'Group not found'
            const trimmed = String(required(name, 'name', 'api_update_group')).trim()
            if (!trimmed) throw 'Group name is required'
            if (state.meetings.folders.some((other) => other.id !== groupId && other.name.toLowerCase() === trimmed.toLowerCase())) {
                throw 'A group with this name already exists'
            }
            Object.assign(folder, {name: trimmed, color: color ?? undefined, kind: kind ?? undefined, description: description ?? undefined, schedule: schedule ?? undefined})
            return folderView(state.meetings, folder)
        },
        api_delete_group: ({groupId}) => {
            const db = state.meetings
            if (!db.folders.some((folder) => folder.id === groupId)) throw 'Group not found'
            db.folders = db.folders.filter((folder) => folder.id !== groupId)
            for (const meeting of db.meetings) if (meeting.group_id === groupId) meeting.group_id = null
            return null
        },
        api_get_meeting_group: ({meetingId}) => {
            const meeting = meetingOf(state.meetings, meetingId)
            const folder = state.meetings.folders.find((entry) => entry.id === meeting.group_id)
            return folder ? folderView(state.meetings, folder) : null
        },
        api_set_meeting_group: ({meetingId, groupId}) => {
            const meeting = state.meetings.meetings.find((entry) => entry.id === meetingId)
            const folderId = typeof groupId === 'string' && groupId.trim() ? groupId : null
            if (!meeting || (folderId && !state.meetings.folders.some((folder) => folder.id === folderId))) {
                throw 'Meeting or group not found'
            }
            meeting.group_id = folderId
            return null
        },

        // ---- summary/commands.rs
        api_get_summary: ({meetingId}): SummaryResponse => {
            const meeting = state.meetings.meetings.find((entry) => entry.id === meetingId)
            const run = state.meetings.summaries[String(meetingId)]
            return {
                status: run?.status ?? 'idle',
                meetingName: meeting?.title ?? null,
                meeting_id: String(meetingId),
                start: run?.start ?? null,
                end: run?.end ?? null,
                data: run?.data ?? null,
                error: run?.error ?? null,
                userEdited: run?.userEdited ?? false,
            }
        },
        api_process_transcript: ({meetingId, text, customPrompt}) => {
            const id = String(required(meetingId, 'meetingId', 'api_process_transcript'))
            const run = state.meetings.summaries[id]
            if (run && (run.status === 'processing' || run.status === 'summarizing')) {
                throw 'Summary generation is already active for this meeting'
            }
            if (!String(text ?? '').trim()) throw 'Failed to save transcript data: empty transcript'
            return {message: 'Summary generation started', process_id: runSummary(state.meetings, id, String(customPrompt ?? ''))}
        },
        api_cancel_summary: ({meetingId}) => {
            const run = state.meetings.summaries[String(meetingId)]
            if (run && (run.status === 'processing' || run.status === 'summarizing')) {
                // Native puts back the summary the run was replacing.
                Object.assign(run, {status: 'cancelled', end: now()})
            }
            return {message: 'Summary generation cancelled'}
        },
        api_save_meeting_summary: ({meetingId, summary, userEdit}) => {
            const id = String(meetingId)
            if (!state.meetings.meetings.some((entry) => entry.id === id)) throw 'Meeting not found or can\'t convert the json'
            const run = state.meetings.summaries[id] ?? {status: 'completed', data: null, error: null, userEdited: false, start: null, end: null}
            run.data = summary
            if (userEdit !== false) run.userEdited = true
            state.meetings.summaries[id] = run
            return {message: 'Meeting summary saved successfully'}
        },
        api_get_meeting_summary_language: ({meetingId}) => {
            const meeting = meetingOf(state.meetings, meetingId)
            return meeting.folder_path
                ? {language: state.meetings.summaryLanguages[meeting.id] ?? null, storage: 'metadata'}
                : {language: null, storage: 'local_fallback'}
        },
        api_save_meeting_summary_language: ({meetingId, summaryLanguage}) => {
            const meeting = meetingOf(state.meetings, meetingId)
            const language = typeof summaryLanguage === 'string' ? summaryLanguage : null
            if (!meeting.folder_path) return {language, storage: 'local_fallback'}
            state.meetings.summaryLanguages[meeting.id] = language
            return {language, storage: 'metadata'}
        },
        api_get_meeting_detected_summary_language: ({meetingId}) => {
            const meeting = meetingOf(state.meetings, meetingId)
            return meeting.folder_path
                ? {language: state.meetings.detectedLanguages[meeting.id] ?? null, storage: 'metadata'}
                : {language: null, storage: 'local_fallback'}
        },
        api_save_meeting_detected_summary_language: ({meetingId, detectedSummaryLanguage}) => {
            const meeting = meetingOf(state.meetings, meetingId)
            const language = typeof detectedSummaryLanguage === 'string' ? detectedSummaryLanguage : null
            if (!meeting.folder_path) return {language, storage: 'local_fallback'}
            state.meetings.detectedLanguages[meeting.id] = language
            return {language, storage: 'metadata'}
        },
        // Native weighs the words of each line; the samples are English.
        api_detect_transcript_summary_language: ({transcriptTexts}) => {
            const texts = (transcriptTexts as string[] | undefined) ?? []
            return texts.some((text) => text.trim()) ? {language: 'en', reason: 'detected'} : {language: null, reason: 'empty'}
        },

        // ---- database/repositories/action_item.rs
        api_list_action_items: ({meetingId, personId, groupId, openOnly, limit}) => {
            const db = state.meetings
            let items = db.actionItems.map((item) => actionView(db, item))
            if (meetingId) items = items.filter((item) => item.meetingId === meetingId)
            if (personId) items = items.filter((item) => item.personId === personId)
            if (groupId) items = items.filter((item) => item.groupId === groupId)
            if (openOnly) items = items.filter((item) => !item.done)
            items.sort((a, b) => (a.meetingId === b.meetingId ? a.position - b.position : b.meetingCreatedAt.localeCompare(a.meetingCreatedAt)))
            return typeof limit === 'number' ? items.slice(0, limit) : items
        },
        api_create_action_item: ({meetingId, text, ownerLabel, dueText, audioTime, transcriptId}) => {
            const db = state.meetings
            const meeting = meetingOf(db, meetingId)
            const item = newActionItem(meeting.id, {
                text: String(required(text, 'text', 'api_create_action_item')),
                ownerLabel: ownerLabel as string | null,
                dueText: dueText as string | null,
                audioTime: audioTime as number | null,
                transcriptId: transcriptId as string | null,
            }, 'user', db.actionItems.filter((entry) => entry.meetingId === meeting.id).length)
            db.actionItems.push(item)
            return actionView(db, item)
        },
        api_update_action_item: ({id, text, ownerLabel, personId, dueText, done}) => {
            const db = state.meetings
            const item = db.actionItems.find((entry) => entry.id === id)
            if (!item) throw 'Action item not found'
            const changed = item.text !== text || (item.ownerLabel ?? null) !== (ownerLabel ?? null) || (item.dueText ?? null) !== (dueText ?? null)
            item.text = String(text)
            item.done = !!done
            item.edited = item.edited || changed || !!done
            item.updatedAt = now()
            for (const [key, value] of [['ownerLabel', ownerLabel], ['personId', personId], ['dueText', dueText]] as const) {
                if (typeof value === 'string' && value) item[key] = value
                else delete item[key]
            }
            if (done) item.doneAt = item.doneAt ?? now()
            else delete item.doneAt
            return actionView(db, item)
        },
        api_delete_action_item: ({id}) => {
            state.meetings.actionItems = state.meetings.actionItems.filter((item) => item.id !== id)
            return null
        },
        api_sync_ai_action_items: ({meetingId, items, sourceFingerprint}) => {
            const db = state.meetings
            const meeting = meetingOf(db, meetingId)
            // Items the user changed or added stay; the summary's are replaced.
            db.actionItems = db.actionItems.filter((item) => item.meetingId !== meeting.id || item.source !== 'ai' || item.edited)
            ;((items as ActionItemDraft[] | undefined) ?? []).forEach((draft, index) => {
                db.actionItems.push(newActionItem(meeting.id, draft, 'ai', index))
            })
            db.actionSources[meeting.id] = String(sourceFingerprint ?? '')
            return db.actionItems.filter((item) => item.meetingId === meeting.id).map((item) => actionView(db, item))
        },
        api_list_unsynced_action_meetings: () =>
            Object.entries(state.meetings.summaries)
                .filter(([meetingId, run]) => run.data && state.meetings.actionSources[meetingId] === undefined)
                .map(([meetingId]) => meetingId),

        // ---- diarization/mod.rs: the speaker commands
        diarization_models_available: () => state.meetings.diarizationAvailable,
        rename_meeting_speaker: ({meetingId, from, to}) => {
            const lines = state.meetings.transcripts[String(meetingId)] ?? []
            const source = String(required(from, 'from', 'rename_meeting_speaker')).trim()
            const target = String(to ?? '').trim()
            const others = new Set(lines.flatMap((line) => (line.speaker ?? '').split(' + ')).filter((label) => /^Speaker \d+$/.test(label)))
            // An empty name gives the voice back a free "Speaker N" label.
            let label = target
            for (let n = 1; !label; n++) if (!others.has(`Speaker ${n}`)) label = `Speaker ${n}`
            let count = 0
            for (const line of lines) {
                const parts = (line.speaker ?? '').split(' + ')
                if (!parts.includes(source)) continue
                line.speaker = [...new Set(parts.map((part) => (part === source ? label : part)))].join(' + ')
                count += 1
            }
            return {speaker: label, count, removedName: !target}
        },
    }
}

// ---- Playback ----------------------------------------------------------------------

/** The path `api_get_meeting_audio` answers in the mock; it names no file. */
export const MOCK_AUDIO_PREFIX = 'mock-audio/'

const audioUrls = new Map<string, string>()

/**
 * A silent WAV as long as `seconds`: 8-bit mono at 3 kHz, the smallest PCM
 * the webview's decoder takes, about 3 kB a second.
 */
function silentWav(seconds: number): string {
    const rate = 3000
    const samples = Math.ceil(seconds * rate)
    const view = new DataView(new ArrayBuffer(44 + samples))
    const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
    text(0, 'RIFF')
    view.setUint32(4, 36 + samples, true)
    text(8, 'WAVE')
    text(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, rate, true)
    view.setUint32(28, rate, true)
    view.setUint16(32, 1, true)
    view.setUint16(34, 8, true)
    text(36, 'data')
    view.setUint32(40, samples, true)
    // 8-bit PCM is unsigned: 128 is silence.
    new Uint8Array(view.buffer, 44).fill(128)
    return URL.createObjectURL(new Blob([view.buffer], {type: 'audio/wav'}))
}

/**
 * `convertFileSrc` for the mock, which @tauri-apps/api/mocks leaves out: a
 * meeting's mock recording becomes a silent WAV as long as its transcript, so
 * the player has a real duration; any other path passes through. It is made
 * on first use and kept for the page's life.
 */
export function installMockAudioSource(state: { meetings: MockMeetings }) {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> }).__TAURI_INTERNALS__
    if (!internals) return
    internals.convertFileSrc = (path: string) => {
        if (!path.startsWith(MOCK_AUDIO_PREFIX) || typeof URL.createObjectURL !== 'function') return path
        const meetingId = path.slice(MOCK_AUDIO_PREFIX.length)
        if (!audioUrls.has(meetingId)) audioUrls.set(meetingId, silentWav((durationOf(state.meetings, meetingId) ?? 30) + 4))
        return audioUrls.get(meetingId)!
    }
}
