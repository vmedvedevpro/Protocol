import type {MutationOptions, QueryClient} from '@tanstack/react-query'
import {describe, expect, it, vi} from 'vitest'
import {handlers} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {listenNative} from './events'
import {registerPostCallControls} from './postCall'
import {
    audioSource,
    deleteFolderMutation,
    DELETE_SETTLE_LIMIT_MS,
    deleteMeetingMutation,
    folderKeys,
    foldersQuery,
    getAllTranscripts,
    getMeetingAudio,
    meetingFolderQuery,
    meetingKeys,
    meetingQuery,
    meetingsQuery,
    meetingTranscriptsQuery,
    renameFolderMutation,
    renameMeetingMutation,
    renameMeetingSpeaker,
    saveSummaryMutation,
    saveTranscript,
    setMeetingFolderMutation,
    startSummary,
    SUMMARY_PROGRESS_EVENT,
    type SummaryProgress,
    summaryQuery,
    summaryTranscriptText,
} from './meetings'

/** Runs a mutation's options as useMutation would, without React. */
function run<TData, TVariables>(client: QueryClient, options: MutationOptions<TData, Error, TVariables>, variables: NoInfer<TVariables>) {
    return client.getMutationCache().build(client, options).execute(variables)
}

describe('meetings', () => {
    it('lists meetings newest first, with their length and folder', async () => {
        const meetings = await createTestQueryClient().fetchQuery(meetingsQuery)

        expect(meetings[0]).toMatchObject({id: 'meeting-acme-review', title: 'Acme pilot security review', group_id: 'group-acme'})
        expect(meetings[0].duration_seconds).toBeGreaterThan(2_600)
        expect(meetings.map((meeting) => meeting.created_at)).toEqual(
            meetings.map((meeting) => meeting.created_at).sort().reverse(),
        )
        expect(meetings.find((meeting) => meeting.id === 'meeting-roadmap')).not.toHaveProperty('group_id')
    })

    it('reads the whole transcript in one call, however long', async () => {
        const lines = Array.from({length: 5000}, (_, index) => ({
            id: `l${index}`, text: `Line ${index}`, timestamp: '09:30:00', audio_start_time: index,
        }))
        mockState.meetings.transcripts['meeting-roadmap'] = lines
        const read = vi.spyOn(handlers, 'api_get_meeting_transcripts')

        const transcript = await createTestQueryClient().fetchQuery(meetingTranscriptsQuery('meeting-roadmap'))

        expect(transcript).toHaveLength(5000)
        expect(read).toHaveBeenCalledTimes(1)
        expect(read.mock.calls[0][0]).toMatchObject({limit: -1, offset: 0})
        expect(await getAllTranscripts('meeting-untitled')).toHaveLength(6)
    })

    it('rejects a meeting that does not exist, as native does', async () => {
        await expect(createTestQueryClient().fetchQuery(meetingQuery('gone'))).rejects.toThrow('Meeting not found: gone')
    })

    it('saves a recording as a new meeting and refreshes the list', async () => {
        const client = createTestQueryClient()
        await client.fetchQuery(meetingsQuery)

        const id = await saveTranscript({
            title: 'Meeting · Tue, Nov 24 · 2:30 PM',
            transcripts: [{id: 'x', text: 'Hello', timestamp: '14:30:00', audio_start_time: 0, audio_end_time: 2, speaker: 'You'}],
            folderPath: '/recordings/2026-11-24',
            recordingStartedAt: '2026-11-24T14:30:00Z',
        })

        expect((await getAllTranscripts(id))[0].speaker).toBe('You')
        expect(mockState.meetings.meetings.find((meeting) => meeting.id === id)?.created_at).toBe('2026-11-24T14:30:00.000Z')
    })

    it('renames a meeting and marks its list, header and folders stale', async () => {
        const client = createTestQueryClient()
        await Promise.all([client.fetchQuery(meetingsQuery), client.fetchQuery(meetingQuery('meeting-roadmap')), client.fetchQuery(foldersQuery)])

        await run(client, renameMeetingMutation('meeting-roadmap'), 'Q4 roadmap')

        for (const key of [meetingKeys.lists(), meetingKeys.detail('meeting-roadmap'), folderKeys.lists()]) {
            expect(client.getQueryState(key)?.isInvalidated).toBe(true)
        }
        expect((await client.fetchQuery(meetingQuery('meeting-roadmap'))).title).toBe('Q4 roadmap')
    })

    it('deletes a meeting and drops its cached queries', async () => {
        const client = createTestQueryClient()
        await client.fetchQuery(meetingQuery('meeting-roadmap'))
        await client.fetchQuery(meetingTranscriptsQuery('meeting-roadmap'))

        await run(client, deleteMeetingMutation('meeting-roadmap'), undefined)

        expect(client.getQueryState(meetingKeys.detail('meeting-roadmap'))).toBeUndefined()
        expect(client.getQueryState(meetingKeys.transcripts('meeting-roadmap'))).toBeUndefined()
        expect((await client.fetchQuery(meetingsQuery)).some((meeting) => meeting.id === 'meeting-roadmap')).toBe(false)
    })

    it('refuses to delete while the meeting’s pass has not let go of it in time', async () => {
        vi.useFakeTimers()
        const unregister = registerPostCallControls({cancel: vi.fn(), retry: vi.fn(), skip: vi.fn(), afterImport: vi.fn(), settled: () => new Promise(() => undefined)})
        try {
            const client = createTestQueryClient()
            const deleting = run(client, deleteMeetingMutation('meeting-roadmap'), undefined)
            const refused = expect(deleting).rejects.toThrow('still processing')
            await vi.advanceTimersByTimeAsync(DELETE_SETTLE_LIMIT_MS)
            await refused
            expect(mockState.meetings.meetings.some((meeting) => meeting.id === 'meeting-roadmap')).toBe(true)
        } finally {
            unregister()
            vi.useRealTimers()
        }
    })

    it('refuses to delete while native still retranscribes the meeting after its pass ended', async () => {
        mockState.postCall.retranscribing = 'meeting-roadmap'
        const client = createTestQueryClient()

        await expect(run(client, deleteMeetingMutation('meeting-roadmap'), undefined)).rejects.toThrow('still processing')
        expect(mockState.meetings.meetings.some((meeting) => meeting.id === 'meeting-roadmap')).toBe(true)
    })

    it('plays a meeting from its recording, and has nothing to play without one', async () => {
        const audio = await getMeetingAudio('meeting-acme-review')

        expect(audio.path).toBe('mock-audio/meeting-acme-review')
        // The mock plays it from a silent WAV as long as the transcript.
        expect(audioSource(audio)).toMatch(/^blob:/)
        // On Linux native serves it itself, and that URL wins.
        expect(audioSource({...audio, playbackUrl: 'http://127.0.0.1:4100/token'})).toBe('http://127.0.0.1:4100/token')
        mockState.meetings.meetings.find((meeting) => meeting.id === 'meeting-1on1')!.folder_path = null
        expect((await getMeetingAudio('meeting-1on1')).path).toBeNull()
    })
})

describe('folders', () => {
    it('lists folders with their meeting counts, latest first', async () => {
        const folders = await createTestQueryClient().fetchQuery(foldersQuery)

        // The sample standups fall on Thursdays, so the order after Acme depends on today.
        expect(folders[0].name).toBe('Acme Corp')
        expect(folders.map((folder) => folder.lastMeetingAt)).toEqual(folders.map((folder) => folder.lastMeetingAt).sort().reverse())
        expect(Object.fromEntries(folders.map((folder) => [folder.name, folder.meetingCount])))
            .toEqual({'Acme Corp': 2, 'Weekly Standup': 5, 'Design Team': 2})
    })

    it('renames a folder, writing back what the folders UI does not show, and leaves open meetings alone', async () => {
        const client = createTestQueryClient()
        const update = vi.spyOn(handlers, 'api_update_group')
        const [acme] = await client.fetchQuery(foldersQuery)
        await Promise.all([
            client.fetchQuery(meetingFolderQuery('meeting-acme-review')),
            client.fetchQuery(meetingTranscriptsQuery('meeting-acme-review')),
            client.fetchQuery(summaryQuery('meeting-acme-review')),
        ])

        await run(client, renameFolderMutation, {folder: acme, name: 'Acme'})

        expect(update.mock.calls[0][0]).toMatchObject({groupId: 'group-acme', name: 'Acme', color: 'orange', kind: 'customer', description: 'Enterprise pilot.'})
        expect(client.getQueryState(meetingKeys.folder('meeting-acme-review'))?.isInvalidated).toBe(true)
        expect(client.getQueryState(meetingKeys.transcripts('meeting-acme-review'))?.isInvalidated).toBe(false)
        expect(client.getQueryState(meetingKeys.summary('meeting-acme-review'))?.isInvalidated).toBe(false)
    })

    it('deletes a folder, keeping its meetings outside any folder', async () => {
        const client = createTestQueryClient()
        await client.fetchQuery(meetingsQuery)

        await run(client, deleteFolderMutation, 'group-acme')

        expect(client.getQueryState(meetingKeys.lists())?.isInvalidated).toBe(true)
        const meetings = await client.fetchQuery(meetingsQuery)
        expect(meetings.find((meeting) => meeting.id === 'meeting-acme-review')).not.toHaveProperty('group_id')
    })

    it('files a meeting in a folder and back out', async () => {
        const client = createTestQueryClient()

        await run(client, setMeetingFolderMutation('meeting-roadmap'), 'group-design')
        expect((await client.fetchQuery(meetingsQuery)).find((meeting) => meeting.id === 'meeting-roadmap')?.group_id).toBe('group-design')

        await run(client, setMeetingFolderMutation('meeting-roadmap'), null)
        expect((await client.fetchQuery(meetingsQuery)).find((meeting) => meeting.id === 'meeting-roadmap')).not.toHaveProperty('group_id')
    })
})

describe('summaries', () => {
    it('reads the stored summary in any of its formats', async () => {
        const client = createTestQueryClient()

        expect((await client.fetchQuery(summaryQuery('meeting-acme-review'))).data).toMatchObject({markdown: expect.stringContaining('## Decisions')})
        expect(typeof (await client.fetchQuery(summaryQuery('meeting-roadmap'))).data).toBe('string')
        expect((await client.fetchQuery(summaryQuery('meeting-untitled'))).status).toBe('idle')
    })

    it('writes a saved edit into the cached summary, so an editor mounted later starts from it', async () => {
        const client = createTestQueryClient()
        await client.fetchQuery(summaryQuery('meeting-roadmap'))
        const edit = {markdown: '## Decisions\n\n- Ship it', summary_json: null}

        await run(client, saveSummaryMutation('meeting-roadmap'), edit)

        expect(client.getQueryData(meetingKeys.summary('meeting-roadmap'))).toMatchObject({status: 'completed', data: edit, userEdited: true})
        expect(mockState.meetings.summaries['meeting-roadmap']).toMatchObject({data: edit, userEdited: true})
    })

    it('sends the transcript with times and voices, and the language Auto detected', async () => {
        const process = vi.spyOn(handlers, 'api_process_transcript')

        const start = await startSummary({meetingId: 'meeting-untitled', provider: 'builtin-ai', model: 'gemma3:1b'})

        expect(start).toEqual({processId: expect.any(String), languageTie: false})
        const args = process.mock.calls[0][0]
        expect(args).toMatchObject({model: 'builtin-ai', modelName: 'gemma3:1b', summaryLanguage: 'en'})
        // No template: native takes the stored default.
        expect(args.templateId).toBeUndefined()
        expect(String(args.text).split('\n')[0]).toBe('[00:04] You: Quick round of updates. What is everyone working on?')
        // Detected once, then kept for the meeting.
        expect(mockState.meetings.detectedLanguages['meeting-untitled']).toBe('en')
    })

    it('keeps a detected language on the device for a meeting without a recording folder', async () => {
        mockState.meetings.meetings.find((meeting) => meeting.id === 'meeting-1on1')!.folder_path = null

        await startSummary({meetingId: 'meeting-1on1', provider: 'ollama', model: 'llama3.2:3b'})

        expect(localStorage.getItem('detectedSummaryLanguageFallback:meeting-1on1')).toBe('en')
    })

    it('prefers the language chosen for the meeting, and tells a bilingual transcript', async () => {
        mockState.meetings.summaryLanguages['meeting-roadmap'] = 'de'
        const process = vi.spyOn(handlers, 'api_process_transcript')
        await startSummary({meetingId: 'meeting-roadmap', provider: 'ollama', model: 'llama3.2:3b'})
        expect(process.mock.calls[0][0]).toMatchObject({summaryLanguage: 'de'})

        vi.spyOn(handlers, 'api_detect_transcript_summary_language').mockReturnValue({language: 'ru', reason: 'tie'})
        const start = await startSummary({meetingId: 'meeting-design-crit', provider: 'ollama', model: 'llama3.2:3b'})
        expect(start.languageTie).toBe(true)
    })

    it('refuses an empty transcript before native sees it', async () => {
        mockState.meetings.transcripts['meeting-roadmap'] = []

        await expect(startSummary({meetingId: 'meeting-roadmap', provider: 'ollama', model: 'x'})).rejects.toThrow('no transcript')
    })

    it('reports the run through summary-progress and stores the new summary', async () => {
        mockState.meetings.summaryRunMs = 0
        const stages: SummaryProgress['stage'][] = []
        const stop = await listenNative(SUMMARY_PROGRESS_EVENT, (progress) => stages.push(progress.stage))
        const client = createTestQueryClient()

        await startSummary({meetingId: 'meeting-untitled', provider: 'ollama', model: 'llama3.2:3b'})
        expect((await client.fetchQuery(summaryQuery('meeting-untitled'))).status).toBe('processing')

        await vi.waitFor(() => expect(stages).toEqual(['preparing', 'generating', 'completed']))
        stop()
        const done = await client.fetchQuery({...summaryQuery('meeting-untitled'), staleTime: 0})
        expect(done.status).toBe('completed')
        expect(done.data).toMatchObject({markdown: expect.stringContaining('## Decisions')})
    })

    it('writes each line with its time and voice', () => {
        const text = summaryTranscriptText([
            {id: 'a', text: 'so yes', timestamp: '09:00:01', speaker: 'You'},
            {id: 'b', text: 'ok', timestamp: '09:00:05', audio_start_time: 65},
        ])

        expect(text).toBe('09:00:01 You: so yes\n[01:05] ok')
    })

    it('sends clean text, and detects the language from it, when asked', async () => {
        const process = vi.spyOn(handlers, 'api_process_transcript')
        const detect = vi.spyOn(handlers, 'api_detect_transcript_summary_language')
        const clean = vi.fn((text: string) => text.replace(/^Quick /, ''))

        await startSummary({meetingId: 'meeting-untitled', provider: 'ollama', model: 'llama3.2:3b', clean})

        expect(clean).toHaveBeenCalledTimes(6)
        expect(String(process.mock.calls[0][0].text).split('\n')[0]).toBe('[00:04] You: round of updates. What is everyone working on?')
        expect((detect.mock.calls[0][0].transcriptTexts as string[])[0]).toBe('round of updates. What is everyone working on?')
    })
})

describe('speakers', () => {
    it('renames a voice on every line it is in, overlaps included', async () => {
        mockState.meetings.transcripts['meeting-untitled'][1].speaker = 'Speaker 1 + You'

        const rename = await renameMeetingSpeaker('meeting-untitled', 'Speaker 1', 'Tom Becker')

        expect(rename).toEqual({speaker: 'Tom Becker', count: 2, removedName: false, removedContact: false})
        expect((await getAllTranscripts('meeting-untitled')).map((line) => line.speaker)).toEqual(
            ['You', 'Tom Becker + You', 'You', 'Tom Becker', 'You', 'Speaker 2'],
        )
    })
})
