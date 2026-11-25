/**
 * Meetings and what belongs to them: the saved transcript, the folders they
 * are filed in, the AI summary, and the speaker labels of their lines.
 * Native code keeps all of it in SQLite (src-tauri/src/api/api.rs,
 * database/repositories/group.rs, summary/commands.rs, diarization/mod.rs);
 * the types mirror the Rust ones,
 * field names included. The notes live in ./notes.ts.
 *
 * "Folder" is the UI's word for what native code and its commands call a
 * group: the Groups page became folders on the meetings list.
 */
import {mutationOptions, type QueryClient, queryOptions} from '@tanstack/react-query'
import {convertFileSrc} from '@tauri-apps/api/core'
import {command} from './core'
import type {NativeEvent} from './events'
// Used only inside callbacks, so the import cycle with people.ts is harmless.
import {peopleKeys} from './people'
import {isRetranscriptionInProgress, postCallControls} from './postCall'

// ---- Meetings ---------------------------------------------------------------

/** One row of the meetings list; mirrors `Meeting` in api.rs. */
export interface MeetingListItem {
    id: string
    title: string
    /** When the recording started (RFC 3339), from its metadata.json when there is one. */
    created_at?: string
    /** The furthest end time of any transcript line, in seconds; absent without lines. */
    duration_seconds?: number
    /** The folder it is filed in. */
    group_id?: string
}

/** A meeting's header data; mirrors `MeetingMetadata` in api.rs. */
export interface MeetingMetadata {
    id: string
    title: string
    /** RFC 3339. */
    created_at: string
    updated_at: string
    /** The recording folder; absent for a meeting saved without one. */
    folder_path?: string
}

/**
 * One transcript line; mirrors `MeetingTranscript` in api.rs, and
 * `TranscriptSegment`, the same fields, which `api_save_transcript` takes.
 * Times are seconds from the start of the recording; lines saved by very old
 * versions have none.
 */
export interface TranscriptSegment {
    id: string
    text: string
    /** Wall-clock time of the line, for reference only ("14:30:05"). */
    timestamp: string
    audio_start_time?: number
    audio_end_time?: number
    duration?: number
    /**
     * Who spoke: "You" for the microphone, "Speaker N" from diarization, a
     * name once someone named the voice, or several joined by " + " where
     * voices overlap. Absent when nothing labelled the line. A saved
     * recording keeps its live labels: the diarization pass after the call
     * finds the user by "You".
     */
    speaker?: string
}

/** A meeting's recordings; mirrors `MeetingAudio` in api.rs. Paths are files on disk. */
export interface MeetingAudio {
    /** The mixed track to play (`audio.mp4`, or the imported file). */
    path: string | null
    micPath: string | null
    systemPath: string | null
    /**
     * Native's own URL for `path` where the asset protocol cannot play media
     * (Linux: WebKitGTK's player takes only http(s), blob, data and file
     * URLs; see recording_stream.rs); null elsewhere.
     */
    playbackUrl: string | null
    /** Where it was saved, when that folder is gone (moved from another computer) and none of its name is in the recordings folder. */
    missingFolder: string | null
}

export const meetingKeys = {
    all: ['meetings'] as const,
    lists: () => [...meetingKeys.all, 'list'] as const,
    detail: (meetingId: string) => [...meetingKeys.all, 'detail', meetingId] as const,
    transcripts: (meetingId: string) => [...meetingKeys.all, 'transcripts', meetingId] as const,
    audio: (meetingId: string) => [...meetingKeys.all, 'audio', meetingId] as const,
    /** Every meeting's folder: a folder renamed or deleted changes them all. */
    folders: () => [...meetingKeys.all, 'folder'] as const,
    folder: (meetingId: string) => [...meetingKeys.folders(), meetingId] as const,
    summary: (meetingId: string) => [...meetingKeys.all, 'summary', meetingId] as const,
}

/** Every meeting, newest first. */
export const getMeetings = () => command<MeetingListItem[]>('api_get_meetings')

/** Rejects with "Meeting not found: <id>" for a meeting that does not exist (any more). */
export const getMeetingMetadata = (meetingId: string) =>
    command<MeetingMetadata>('api_get_meeting_metadata', {meetingId})

/**
 * The whole transcript in start-time order. `api_get_meeting_transcripts`
 * answers a page (`PaginatedTranscriptsResponse`); a limit of -1 is SQLite's
 * "no limit", so one call returns every line. The view needs them all too:
 * playback and a jump can land anywhere in the meeting, and rows off screen
 * cost little (see TranscriptList).
 */
export async function getAllTranscripts(meetingId: string): Promise<TranscriptSegment[]> {
    const page = await command<{ transcripts: TranscriptSegment[] }>('api_get_meeting_transcripts', {
        meetingId,
        limit: -1,
        offset: 0,
    })
    return page.transcripts
}

/**
 * Saves a recording's transcript as a new meeting and answers its id (#112,
 * after Stop). `recordingStartedAt` (RFC 3339) dates the meeting when the
 * folder has no metadata.json to read it from.
 */
export async function saveTranscript(draft: {
    title: string
    transcripts: TranscriptSegment[]
    folderPath: string | null
    recordingStartedAt?: string | null
}): Promise<string> {
    const reply = await command<{ meeting_id: string }>('api_save_transcript', {
        meetingTitle: draft.title,
        transcripts: draft.transcripts,
        folderPath: draft.folderPath,
        recordingStartedAt: draft.recordingStartedAt ?? null,
    })
    return reply.meeting_id
}

/**
 * A manual title. Native marks it manual, so a summary never renames the
 * meeting afterwards (see PARITY.md, Automatic meeting titles).
 */
export const renameMeeting = (meetingId: string, title: string) =>
    command<unknown>('api_save_meeting_title', {meetingId, title})

/**
 * Deletes the meeting with its transcript, summary, notes and action items.
 * The audio stays in the recordings folder.
 */
export const deleteMeeting = (meetingId: string) => command<unknown>('api_delete_meeting', {meetingId})

/** Opens the recording folder in the file manager; rejects when it is gone. */
export const openMeetingFolder = (meetingId: string) => command<null>('open_meeting_folder', {meetingId})

/**
 * The meeting's recordings. Native adds their folder to the asset scope on
 * the way, so `audioSource` can stream them.
 */
export const getMeetingAudio = (meetingId: string) => command<MeetingAudio>('api_get_meeting_audio', {meetingId})

/** A URL the webview can play a meeting's recording from: native's, else Tauri's asset protocol. */
export const audioSource = (audio: MeetingAudio) => audio.playbackUrl ?? (audio.path === null ? null : convertFileSrc(audio.path))

export const meetingsQuery = queryOptions({
    queryKey: meetingKeys.lists(),
    queryFn: getMeetings,
})

export const meetingQuery = (meetingId: string) =>
    queryOptions({
        queryKey: meetingKeys.detail(meetingId),
        queryFn: () => getMeetingMetadata(meetingId),
    })

/** The whole transcript; read again after a speaker rename or a diarization pass. */
export const meetingTranscriptsQuery = (meetingId: string) =>
    queryOptions({
        queryKey: meetingKeys.transcripts(meetingId),
        queryFn: () => getAllTranscripts(meetingId),
    })

export const meetingAudioQuery = (meetingId: string) =>
    queryOptions({
        queryKey: meetingKeys.audio(meetingId),
        queryFn: () => getMeetingAudio(meetingId),
    })

/** After a meeting was added, renamed, moved or deleted: the list, folder counts, its header. */
function invalidateMeeting(client: QueryClient, meetingId: string) {
    return Promise.all([
        client.invalidateQueries({queryKey: meetingKeys.lists()}),
        client.invalidateQueries({queryKey: meetingKeys.detail(meetingId)}),
        client.invalidateQueries({queryKey: meetingKeys.folder(meetingId)}),
        client.invalidateQueries({queryKey: folderKeys.all}),
    ])
}

export const saveTranscriptMutation = mutationOptions({
    mutationFn: saveTranscript,
    onSuccess: (meetingId, _draft, _result, {client}) => invalidateMeeting(client, meetingId),
})

export const renameMeetingMutation = (meetingId: string) =>
    mutationOptions({
        mutationFn: (title: string) => renameMeeting(meetingId, title),
        onSuccess: (_reply, _title, _result, {client}) => invalidateMeeting(client, meetingId),
    })

/**
 * How long Delete waits for the meeting's post-call pass to let go of it. A
 * cancelled retranscription stops after the piece it is on, at most 25 s of
 * audio (post_meeting.rs, `MAX_PIECE_SAMPLES`), and the runner gives native
 * the same two minutes to let go of the model (`RUNNER_TIMING.releaseLimitMs`);
 * a summary stops at its next poll. What still runs past it cannot be
 * stopped (a speaker identification) or ignores the cancel, so Delete refuses
 * rather than delete a meeting native still writes into.
 */
export const DELETE_SETTLE_LIMIT_MS = 2 * 60 * 1000

const STILL_PROCESSING = 'Protocol is still processing this meeting. Try again when it has finished.'

/**
 * Deleting drops the meeting's own queries rather than refetching them: a
 * screen still showing it would read "Meeting not found". Its post-call
 * pass is cancelled first and the delete waits for it to settle (the
 * Delete button shows the wait): native's cancel only sets a flag, and a
 * retranscription finishes the piece it is on before it stops, so deleting
 * at once would let that piece write into a meeting that is gone. A pass
 * also settles when its own wait for native gives up, so native is asked
 * once more before the delete.
 */
export const deleteMeetingMutation = (meetingId: string) =>
    mutationOptions({
        mutationFn: async () => {
            postCallControls.cancel(meetingId)
            let timer: ReturnType<typeof setTimeout> | undefined
            const settled = await Promise.race([
                postCallControls.settled(meetingId).then(() => true),
                new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), DELETE_SETTLE_LIMIT_MS)
                }),
            ]).finally(() => clearTimeout(timer))
            if (!settled || await isRetranscriptionInProgress(meetingId).catch(() => false)) throw new Error(STILL_PROCESSING)
            return deleteMeeting(meetingId)
        },
        onSuccess: async (_reply, _variables, _result, {client}) => {
            for (const key of [meetingKeys.detail, meetingKeys.transcripts, meetingKeys.audio, meetingKeys.folder, meetingKeys.summary]) {
                client.removeQueries({queryKey: key(meetingId)})
            }
            await Promise.all([
                client.invalidateQueries({queryKey: meetingKeys.lists()}),
                client.invalidateQueries({queryKey: folderKeys.all}),
            ])
        },
    })

// ---- Folders ------------------------------------------------------------------

/**
 * A folder; mirrors `GroupListItem` in group.rs. The Groups page's colour,
 * kind, description and schedule stay on the row for meetings filed before
 * the redesign; the folders UI neither shows nor changes them, and an edit
 * writes them back as they were.
 */
export interface Folder {
    id: string
    name: string
    color?: string
    kind?: string
    description?: string
    schedule?: unknown
    meetingCount: number
    lastMeetingAt?: string
    lastMeetingId?: string
    lastMeetingTitle?: string
    createdAt: string
}

export const folderKeys = {
    all: ['folders'] as const,
    lists: () => [...folderKeys.all, 'list'] as const,
}

/** Folders, the one with the latest meeting first. */
export const getFolders = () => command<Folder[]>('api_list_groups')

/** Native rejects a blank name and a name another folder has. */
export const createFolder = (name: string) =>
    command<Folder>('api_create_group', {name, color: null, kind: null, description: null, schedule: null})

/** Renames a folder, keeping the fields the folders UI does not show. */
export const renameFolder = (folder: Folder, name: string) =>
    command<Folder>('api_update_group', {
        groupId: folder.id,
        name,
        color: folder.color ?? null,
        kind: folder.kind ?? null,
        description: folder.description ?? null,
        schedule: folder.schedule ?? null,
    })

/** Deletes a folder; its meetings stay, filed in no folder. */
export const deleteFolder = (folderId: string) => command<null>('api_delete_group', {groupId: folderId})

/** The folder a meeting is filed in, or null. */
export const getMeetingFolder = (meetingId: string) =>
    command<Folder | null>('api_get_meeting_group', {meetingId})

/** Files a meeting in a folder, or in none with `null`. */
export const setMeetingFolder = (meetingId: string, folderId: string | null) =>
    command<null>('api_set_meeting_group', {meetingId, groupId: folderId})

export const foldersQuery = queryOptions({
    queryKey: folderKeys.lists(),
    queryFn: getFolders,
})

export const meetingFolderQuery = (meetingId: string) =>
    queryOptions({
        queryKey: meetingKeys.folder(meetingId),
        queryFn: () => getMeetingFolder(meetingId),
    })

export const createFolderMutation = mutationOptions({
    mutationFn: createFolder,
    onSuccess: (_folder, _name, _result, {client}) => client.invalidateQueries({queryKey: folderKeys.all}),
})

export const renameFolderMutation = mutationOptions({
    mutationFn: ({folder, name}: { folder: Folder, name: string }) => renameFolder(folder, name),
    onSuccess: (_folder, _variables, _result, {client}) =>
        Promise.all([
            client.invalidateQueries({queryKey: folderKeys.all}),
            // A meeting's header names its folder.
            client.invalidateQueries({queryKey: meetingKeys.folders()}),
        ]),
})

export const deleteFolderMutation = mutationOptions({
    mutationFn: deleteFolder,
    onSuccess: (_reply, _folderId, _result, {client}) =>
        Promise.all([
            client.invalidateQueries({queryKey: folderKeys.all}),
            client.invalidateQueries({queryKey: meetingKeys.folders()}),
            // Its meetings leave it, which the list's folder filter reads.
            client.invalidateQueries({queryKey: meetingKeys.lists()}),
        ]),
})

export const setMeetingFolderMutation = (meetingId: string) =>
    mutationOptions({
        mutationFn: (folderId: string | null) => setMeetingFolder(meetingId, folderId),
        onSuccess: (_reply, _folderId, _result, {client}) => invalidateMeeting(client, meetingId),
    })

// ---- Summaries -------------------------------------------------------------------

/**
 * Where a summary run stands, as `summary_processes.status` stores it, in
 * lower case. `idle` means no run was ever started.
 */
export type SummaryStatus = 'idle' | 'pending' | 'processing' | 'summarizing' | 'completed' | 'cancelled' | 'failed' | 'error'

/** `api_get_summary`; mirrors `SummaryResponse` in summary/commands.rs. */
export interface SummaryResponse {
    status: SummaryStatus
    meetingName: string | null
    meeting_id: string
    start: string | null
    end: string | null
    /**
     * The summary in whichever format it was stored: a plain or double-encoded
     * string, `{markdown, summary_json}`, or the older map of titled sections.
     * A run that is still going, or that failed, can carry the previous one.
     */
    data: unknown
    error: string | null
    /** The user edited the stored summary by hand. */
    userEdited: boolean
}

/** Statuses of a run that is still going. */
export function isSummaryRunning(status: SummaryStatus | undefined): boolean {
    return status === 'pending' || status === 'processing' || status === 'summarizing'
}

/** Pushed while a run goes, with the run's `processId` (summary/service.rs). */
export interface SummaryProgress {
    meetingId: string
    processId: string
    stage: 'preparing' | 'generating' | 'completed' | 'cancelled' | 'error'
    message: string
    /** The new summary, on `completed`. */
    data: unknown
}

/**
 * Says that a run moved on; the stored summary is the truth, so listeners
 * invalidate `meetingKeys.summary`. Not every failure sends it (one before
 * the run's first step only marks the row failed), so a running summary is
 * also read again on a timer (`SUMMARY_POLL_MS`).
 */
export const SUMMARY_PROGRESS_EVENT = 'summary-progress' as NativeEvent<SummaryProgress>

/** How often a running summary is read again, for runs that end without an event. */
export const SUMMARY_POLL_MS = 5000

export const getSummary = (meetingId: string) => command<SummaryResponse>('api_get_summary', {meetingId})

/**
 * Stops a run. Native puts back the summary the run was replacing, if any,
 * and marks the run cancelled.
 */
export const cancelSummary = (meetingId: string) => command<unknown>('api_cancel_summary', {meetingId})

/**
 * Saves a summary the user edited, in the format the editor keeps: Markdown
 * for search, export and AI agents, and the BlockNote blocks.
 */
export const saveSummary = (meetingId: string, summary: { markdown: string, summary_json: unknown[] | null }) =>
    command<unknown>('api_save_meeting_summary', {meetingId, summary, userEdit: true})

/**
 * The stored summary and its run. While a run goes it is read again every
 * `SUMMARY_POLL_MS`; `summary-progress` invalidates it sooner.
 */
export const summaryQuery = (meetingId: string) =>
    queryOptions({
        queryKey: meetingKeys.summary(meetingId),
        queryFn: () => getSummary(meetingId),
        refetchInterval: (query) => (isSummaryRunning(query.state.data?.status) ? SUMMARY_POLL_MS : false),
    })

export const cancelSummaryMutation = (meetingId: string) =>
    mutationOptions({
        mutationFn: () => cancelSummary(meetingId),
        onSettled: (_reply, _error, _variables, _result, {client}) =>
            client.invalidateQueries({queryKey: meetingKeys.summary(meetingId)}),
    })

/**
 * Edits of a summary share a scope, so they reach native in the order they
 * were made, as the notes do. Each saved edit is written into the cached
 * summary instead of reading it back, so an editor mounted later (the tab
 * opened again) starts from it, and the run's other fields stay as read.
 */
export const saveSummaryMutation = (meetingId: string) =>
    mutationOptions({
        mutationFn: (summary: { markdown: string, summary_json: unknown[] | null }) => saveSummary(meetingId, summary),
        scope: {id: `summary:${meetingId}`},
        onSuccess: (_reply, summary, _result, {client}) => {
            client.setQueryData<SummaryResponse>(meetingKeys.summary(meetingId), (old) => old && {...old, data: summary, userEdited: true})
        },
    })

// ---- Starting a summary ------------------------------------------------------------

/** Why Auto picked no language, or picked one; mirrors `SummaryLanguageDetection`. */
export interface SummaryLanguageDetection {
    language: string | null
    reason: 'detected' | 'tie' | 'low_confidence' | 'unsupported' | 'empty'
}

/**
 * A per-meeting language as native answers it
 * (`MeetingSummaryLanguagePreference`). `local_fallback` means the meeting
 * has no metadata.json to keep it in, and the UI keeps it in localStorage
 * instead (the `…Fallback:<meetingId>` keys below).
 */
interface MeetingLanguageReply {
    language: string | null
    storage: 'metadata' | 'local_fallback'
}

// Per-meeting localStorage keys of the old UI, read and written as it did
// (docs/UI_ARCHITECTURE.md, Native data; PARITY.md, localStorage).
const LANGUAGE_FALLBACK_PREFIX = 'summaryLanguageFallback'
const DETECTED_LANGUAGE_FALLBACK_PREFIX = 'detectedSummaryLanguageFallback'

function languageCode(raw: unknown): string | null {
    if (typeof raw !== 'string') return null
    const code = raw.trim().toLowerCase().replace(/_/g, '-')
    return code || null
}

function readFallback(prefix: string, meetingId: string): string | null {
    try {
        return languageCode(localStorage.getItem(`${prefix}:${meetingId}`))
    } catch {
        return null
    }
}

function writeFallback(prefix: string, meetingId: string, language: string | null) {
    try {
        const key = `${prefix}:${meetingId}`
        if (language) localStorage.setItem(key, language)
        else localStorage.removeItem(key)
    } catch {
        // Without storage the language is detected again next time.
    }
}

/** The language the user chose for this meeting's summary (Summary options, #119), or null for Auto. */
export async function getMeetingSummaryLanguage(meetingId: string): Promise<string | null> {
    const reply = await command<MeetingLanguageReply>('api_get_meeting_summary_language', {meetingId})
    if (reply.storage === 'local_fallback') return readFallback(LANGUAGE_FALLBACK_PREFIX, meetingId)
    writeFallback(LANGUAGE_FALLBACK_PREFIX, meetingId, null)
    return reply.language
}

/**
 * Chooses the language of this meeting's summary; null goes back to Auto.
 * The recording applies the pinned default to a meeting it saves (#112);
 * Summary options sets it per meeting (#119).
 */
export async function saveMeetingSummaryLanguage(meetingId: string, language: string | null): Promise<void> {
    const reply = await command<MeetingLanguageReply>('api_save_meeting_summary_language', {
        meetingId,
        summaryLanguage: language,
    })
    writeFallback(LANGUAGE_FALLBACK_PREFIX, meetingId, reply.storage === 'local_fallback' ? language : null)
}

/** The language Auto detected for this meeting before, so it is not detected again. */
export async function getDetectedSummaryLanguage(meetingId: string): Promise<string | null> {
    const reply = await command<MeetingLanguageReply>('api_get_meeting_detected_summary_language', {meetingId})
    if (reply.storage === 'local_fallback') return readFallback(DETECTED_LANGUAGE_FALLBACK_PREFIX, meetingId)
    writeFallback(DETECTED_LANGUAGE_FALLBACK_PREFIX, meetingId, null)
    return reply.language
}

export async function saveDetectedSummaryLanguage(meetingId: string, language: string | null): Promise<void> {
    const reply = await command<MeetingLanguageReply>('api_save_meeting_detected_summary_language', {
        meetingId,
        detectedSummaryLanguage: language,
    })
    writeFallback(DETECTED_LANGUAGE_FALLBACK_PREFIX, meetingId, reply.storage === 'local_fallback' ? language : null)
}

export const detectSummaryLanguage = (transcriptTexts: string[]) =>
    command<SummaryLanguageDetection>('api_detect_transcript_summary_language', {transcriptTexts})

/**
 * The language a summary is written in: the one chosen for the meeting, or
 * the one detected for it before, or the transcript's main language, which
 * is then kept for next time. `tie` means two languages weighed the same
 * (a bilingual call): Auto picked one, and the user may want the other.
 * Every step that fails falls through to the next; null leaves it to native.
 */
export async function resolveSummaryLanguage(meetingId: string, texts: string[]): Promise<{
    language: string | null
    tie: boolean
}> {
    const chosen = await getMeetingSummaryLanguage(meetingId).catch(() => null)
    if (chosen) return {language: chosen, tie: false}
    const detected = await getDetectedSummaryLanguage(meetingId).catch(() => null)
    if (detected) return {language: detected, tie: false}
    try {
        const detection = await detectSummaryLanguage(texts)
        const language = languageCode(detection.language)
        if (language) await saveDetectedSummaryLanguage(meetingId, language).catch(() => undefined)
        return {language, tie: detection.reason === 'tie'}
    } catch {
        return {language: null, tie: false}
    }
}

const clock = (seconds: number) => {
    const total = Math.floor(seconds)
    return `[${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}]`
}

/** The transcript as a summary reads it, one line per segment: `[mm:ss] Speaker: text`. */
export function summaryTranscriptText(lines: TranscriptSegment[]): string {
    return lines
        .map((line) => {
            const time = line.audio_start_time === undefined ? line.timestamp : clock(line.audio_start_time)
            return `${time} ${line.speaker ? `${line.speaker}: ` : ''}${line.text}`
        })
        .join('\n')
}

export interface SummaryRequest {
    meetingId: string
    /** The summary model as Settings stores it: `provider` (ollama, builtin-ai, claude…) and `model`. */
    provider: string
    model: string
    templateId?: string
    /** One-off instructions for this run. */
    customPrompt?: string
    /** Tidies each line's text first (Labs › Clean transcript); the saved transcript never changes. */
    clean?: (text: string) => string
}

export interface SummaryStart {
    /** Native's id for the run; `summary-progress` carries it. */
    processId: string
    /** The transcript is bilingual and Auto picked one of the two; worth telling the user. */
    languageTie: boolean
}

/**
 * Starts a summary of the saved transcript and answers once native accepted
 * the run; the run itself goes on natively, which holds it as busy work for
 * the updater. Used by the meeting's Generate and Write again (#113) and by
 * the automatic summary after Stop (#112). Checks of the model itself
 * (downloaded, installed) are the caller's: they need the model domains.
 * Rejects when the transcript is empty or a run of this meeting is already
 * going ("Summary generation is already active for this meeting").
 */
export async function startSummary(request: SummaryRequest): Promise<SummaryStart> {
    const saved = await getAllTranscripts(request.meetingId)
    if (saved.length === 0) throw new Error('This meeting has no transcript to summarize')
    const {clean} = request
    const lines = clean ? saved.map((line) => ({...line, text: clean(line.text) || line.text})) : saved
    const {language, tie} = await resolveSummaryLanguage(request.meetingId, lines.map((line) => line.text))
    const reply = await command<{ process_id: string }>('api_process_transcript', {
        text: summaryTranscriptText(lines),
        model: request.provider,
        modelName: request.model,
        meetingId: request.meetingId,
        chunkSize: 40000,
        overlap: 1000,
        customPrompt: request.customPrompt ?? '',
        // Left out, native uses the stored default template (src/api/templates.ts).
        templateId: request.templateId,
        summaryLanguage: language,
    })
    return {processId: reply.process_id, languageTie: tie}
}

export const startSummaryMutation = mutationOptions({
    mutationFn: startSummary,
    onSettled: (_start, _error, request, _result, {client}) =>
        client.invalidateQueries({queryKey: meetingKeys.summary(request.meetingId)}),
})

// ---- Speakers --------------------------------------------------------------------------

/** Mirrors `MeetingSpeakerRenameResult` in diarization/mod.rs. */
export interface SpeakerRename {
    /** The label the lines carry now. */
    speaker: string
    /** How many lines changed. */
    count: number
    /** `to` was empty, so the voice went back to a "Speaker N" label. */
    removedName: boolean
    /** `from`'s contact had no lines left anywhere and was removed (with `removeEmptiedContact`). */
    removedContact: boolean
}

/**
 * Renames one voice on every line of the meeting that carries it, including
 * the lines where it overlaps another voice. Native also links the name to
 * a contact of the same name.
 */
/**
 * Relabels every line of `from`. With `removeEmptiedContact` (after the Who
 * said this sheet's warning) native also removes `from`'s contact when no
 * meeting has its lines any more: merged into the contact the lines went to,
 * or deleted, in the same transaction.
 */
export const renameMeetingSpeaker = (meetingId: string, from: string, to: string, {removeEmptiedContact = false} = {}) =>
    command<SpeakerRename>('rename_meeting_speaker', {meetingId, from, to, removeEmptiedContact})

/**
 * Whether a speaker engine is installed, so the speaker count can be
 * changed; the rerun itself is `diarizeMeeting` in ./postCall.ts (#112).
 */
export const diarizationAvailable = () => command<boolean>('diarization_models_available')

export const diarizationAvailableQuery = queryOptions({
    queryKey: [...meetingKeys.all, 'diarizationAvailable'] as const,
    queryFn: diarizationAvailable,
})

/**
 * Names a voice for the meeting. Native links a name to the contact who has
 * it, or makes a new contact (person.rs, `ensure_label_identity`), so the
 * people are read again with the transcript.
 */
export const renameSpeakerMutation = (meetingId: string) =>
    mutationOptions({
        mutationFn: ({from, to}: { from: string, to: string }) => renameMeetingSpeaker(meetingId, from, to),
        onSuccess: (_rename, _variables, _result, {client}) => Promise.all([
            client.invalidateQueries({queryKey: meetingKeys.transcripts(meetingId)}),
            client.invalidateQueries({queryKey: peopleKeys.all}),
        ]),
    })

