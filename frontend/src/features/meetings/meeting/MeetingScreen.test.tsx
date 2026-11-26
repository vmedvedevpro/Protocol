import {act, renderHook, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {setLab} from '@/api/labs'
import {type OpenedDialog, useDialog} from '@/lib/dialogs'
import {handlers, type MockArgs} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {renderRoute} from '../testing'
import {MeetingRoute} from './MeetingScreen'

// A StatusLine says its text twice: the live region is the copy that counts.
const LIVE = {selector: '[role="status"]'}

const renderMeeting = (meetingId: string, query = '') => renderRoute(`/meetings/${meetingId}${query}`, [
    {path: '/', element: <p>Home</p>},
    {path: '/meetings/:meetingId', element: <MeetingRoute/>},
])

// The mock's runs end at once: a test waits for the state it reads, never for
// wall time, and holds a run with `hold` when it reads the state in between.
beforeEach(() => {
    mockState.meetings.summaryRunMs = 0
    mockState.postCall.stepMs = 0
})

/** Holds a mock command until `release`, then runs it as the mock does. */
function hold(command: string) {
    const original = handlers[command]
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const spy = vi.spyOn(handlers, command).mockImplementationOnce(async (args: MockArgs) => {
        await gate
        return original(args)
    })
    return {spy, release}
}

/** What the Identify speakers sheet does on Identify: hand the count to the screen's run. */
function identifyFromSheet(request: OpenedDialog | null, count: number | null) {
    if (request?.kind !== 'identify-speakers') throw new Error('The Identify speakers sheet is not open')
    request.identify(count)
}

describe('MeetingScreen', () => {
    it('shows the title, when it was, how long and its folder', async () => {
        renderMeeting('meeting-acme-review')
        expect(await screen.findByRole('heading', {level: 1, name: 'Acme pilot security review'})).toBeInTheDocument()
        const header = screen.getByRole('heading', {level: 1, name: 'Acme pilot security review'}).closest('div') as HTMLElement
        await waitFor(() => expect(header).toHaveTextContent(/Today, .*, \d+ min, Acme Corp$/))
    })

    it('opens on the summary with its action section as the model wrote it', async () => {
        // The editor is a lazy chunk; see NotesEditor.test.tsx.
        await import('@/components/editor/NotesEditorView')
        renderMeeting('meeting-acme-review')
        const summary = await screen.findByRole('textbox', {name: 'Summary'})
        await waitFor(() => expect(summary).toHaveTextContent(/Prepare a local-models-only configuration for the pilot group/))
        expect(screen.queryByRole('region', {name: 'Action items'})).not.toBeInTheDocument()
        // Nothing moves the section out of the stored summary (#218).
        expect(mockState.meetings.summaries['meeting-acme-review'].data).toMatchObject({markdown: expect.stringContaining('## Action items')})
        expect(screen.getByText('Written from the transcript.')).toBeInTheDocument()
    })

    it('switches tabs with ⌘1, ⌘2 and ⌘3, and keeps the tab in the URL', async () => {
        const {router} = renderMeeting('meeting-acme-review')
        await screen.findByRole('tab', {name: 'Summary', selected: true})
        await userEvent.keyboard('{Control>}2{/Control}')
        expect(screen.getByRole('tab', {name: 'Transcript', selected: true})).toBeInTheDocument()
        expect(router.state.location.search).toBe('?tab=transcript')
        expect(await screen.findByRole('region', {name: 'Transcript'})).toBeInTheDocument()
        await userEvent.keyboard('{Control>}1{/Control}')
        expect(screen.getByRole('tab', {name: 'Notes', selected: true})).toBeInTheDocument()
    })

    it('writes a summary the meeting has none of', async () => {
        const start = hold('api_process_transcript')
        renderMeeting('meeting-untitled')
        await userEvent.click(await screen.findByRole('button', {name: 'Generate summary'}))
        expect(await screen.findByText('Writing the summary…', LIVE)).toBeInTheDocument()

        start.release()
        expect(await screen.findByText('Written from the transcript.')).toBeInTheDocument()
        expect(mockState.meetings.summaries['meeting-untitled'].status).toBe('completed')
    })

    it('asks for a summary model first when none is chosen', async () => {
        mockState.preferences.summaryModel = null
        renderMeeting('meeting-untitled')
        await userEvent.click(await screen.findByRole('button', {name: 'Generate summary'}))
        expect(await screen.findByText('Choose a summary model')).toBeInTheDocument()
        expect(mockState.meetings.summaries['meeting-untitled']).toBeUndefined()
    })

    it('opens Summary options to write the summary again', async () => {
        renderMeeting('meeting-roadmap')
        const options = renderHook(() => useDialog())
        await userEvent.click(await screen.findByRole('button', {name: 'Write the summary again'}))
        expect(options.result.current).toMatchObject({open: true, request: {meetingId: 'meeting-roadmap'}})
    })

    it('shows the clean transcript with Labs, and every word under Verbatim', async () => {
        const [first] = mockState.meetings.transcripts['meeting-acme-review']
        first.text = 'Um, we we start with the pilot.'
        setLab('cleanTranscript', true)
        renderMeeting('meeting-acme-review', '?tab=transcript')
        const transcript = await screen.findByRole('region', {name: 'Transcript'})
        expect(await within(transcript).findByText('We start with the pilot.')).toBeInTheDocument()
        // Clean/Verbatim is the transcript's own control, not one more in the tab row.
        expect(within(screen.getByRole('tabpanel')).getByRole('radiogroup', {name: 'Transcript text'})).toBeInTheDocument()

        // The radio is invisible to the pointer; a user clicks its label.
        await userEvent.click(screen.getByRole('radio', {name: 'Verbatim'}).closest('label') as HTMLElement)

        expect(await within(transcript).findByText('Um, we we start with the pilot.')).toBeInTheDocument()
    })

    it('copies the transcript with times and speakers', async () => {
        const user = userEvent.setup()
        renderMeeting('meeting-acme-review')
        await user.click(await screen.findByRole('button', {name: /More actions/}))
        await user.click(screen.getByRole('menuitem', {name: 'Copy transcript'}))
        await screen.findByText('Transcript copied')
        const copied = await navigator.clipboard.readText()
        expect(copied).toMatch(/^# Acme pilot security review\n\n[^_\n]+\n\n## Transcript\n\n\[\d\d:\d\d\] \*\*/)
    })

    it('moves the meeting to another folder', async () => {
        renderMeeting('meeting-acme-review')
        await userEvent.click(await screen.findByRole('button', {name: /More actions/}))
        await userEvent.click(screen.getByRole('menuitem', {name: 'Move to folder'}))
        await userEvent.click(await screen.findByRole('menuitemradio', {name: 'Design Team'}))
        await waitFor(() => expect(screen.getByText('Design Team', {selector: 'p span, span span'})).toBeInTheDocument())
    })

    it('opens Export and Improve the transcript from the menu', async () => {
        renderMeeting('meeting-acme-review')
        const exportDialog = renderHook(() => useDialog())
        const enhanceDialog = renderHook(() => useDialog())
        await userEvent.click(await screen.findByRole('button', {name: /More actions/}))
        await userEvent.click(screen.getByRole('menuitem', {name: 'Export…'}))
        expect(exportDialog.result.current.request).toMatchObject({meetingId: 'meeting-acme-review'})

        await userEvent.click(screen.getByRole('button', {name: /More actions/}))
        await userEvent.click(await screen.findByRole('menuitem', {name: 'Improve the transcript…'}))
        expect(enhanceDialog.result.current).toMatchObject({open: true, request: {meetingId: 'meeting-acme-review'}})
    })

    it('keeps Improve and Identify speakers when the recording cannot be played here', async () => {
        // The WebView refuses the file (WebKitGTK did, #121): native still has it.
        vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
            queueMicrotask(() => this.dispatchEvent(new Event('error')))
        })
        renderMeeting('meeting-acme-review')
        expect(await screen.findByText(/couldn’t be played/)).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: /More actions/}))
        expect(await screen.findByRole('menuitem', {name: 'Improve the transcript…'})).toBeInTheDocument()
        expect(screen.getByRole('menuitem', {name: 'Identify speakers again…'})).toBeInTheDocument()
    })

    it('opens Who said this from a speaker’s menu', async () => {
        renderMeeting('meeting-untitled', '?tab=transcript')
        const speaker = renderHook(() => useDialog())
        await userEvent.click((await screen.findAllByRole('button', {name: 'Speaker 1'}))[0])
        await userEvent.click(await screen.findByRole('menuitem', {name: 'Who said this…'}))
        expect(speaker.result.current.request).toMatchObject({meetingId: 'meeting-untitled', speaker: 'Speaker 1', lineIds: [expect.any(String)]})
    })

    it('asks for the speaker count in a sheet before identifying the speakers again', async () => {
        const run = vi.spyOn(handlers, 'diarize_meeting')
        renderMeeting('meeting-acme-review', '?tab=transcript')
        const dialog = renderHook(() => useDialog())
        await userEvent.click(await screen.findByRole('button', {name: 'Identify speakers…'}))
        // The sheet (features/dialogs) asks and confirms; opening it starts nothing.
        expect(dialog.result.current).toMatchObject({open: true, request: {kind: 'identify-speakers'}})
        expect(run).not.toHaveBeenCalled()

        act(() => identifyFromSheet(dialog.result.current.request, 4))
        expect(await screen.findByText('Found 4 speakers')).toBeInTheDocument()
        expect(run.mock.calls[0][0]).toMatchObject({meetingId: 'meeting-acme-review', numSpeakers: 4})
    })

    it('says so when a run ends with the labels the meeting already had', async () => {
        mockState.postCall.diarization = {labeled: 12, changed: 0, labelledBefore: 12, speakersOnLines: null}
        renderMeeting('meeting-acme-review', '?tab=transcript')
        const dialog = renderHook(() => useDialog())
        await userEvent.click(await screen.findByRole('button', {name: 'Identify speakers…'}))
        act(() => identifyFromSheet(dialog.result.current.request, 2))
        expect(await screen.findByText('Found 2 speakers again')).toBeInTheDocument()
        expect(screen.getByText('Every line already had these labels, so none changed.')).toBeInTheDocument()
    })

    it('does not say again on a first run that labelled no line', async () => {
        mockState.postCall.diarization = {labeled: 0, changed: 0, labelledBefore: 0, speakersOnLines: null}
        renderMeeting('meeting-acme-review', '?tab=transcript')
        const dialog = renderHook(() => useDialog())
        await userEvent.click(await screen.findByRole('button', {name: 'Identify speakers…'}))
        act(() => identifyFromSheet(dialog.result.current.request, 2))
        expect(await screen.findByText('Found 2 speakers')).toBeInTheDocument()
        expect(screen.getByText('No transcript line got a label.')).toBeInTheDocument()
        expect(screen.queryByText('Found 2 speakers again')).not.toBeInTheDocument()
    })

    it('says so when a speaker it found labels no line', async () => {
        mockState.postCall.diarization = {labeled: 12, changed: 3, labelledBefore: 12, speakersOnLines: 1}
        renderMeeting('meeting-acme-review', '?tab=transcript')
        const dialog = renderHook(() => useDialog())
        await userEvent.click(await screen.findByRole('button', {name: 'Identify speakers…'}))
        act(() => identifyFromSheet(dialog.result.current.request, null))
        expect(await screen.findByText('Found 3 speakers, 1 on the transcript')).toBeInTheDocument()
    })

    it('starts one speaker run when the sheet’s Identify comes twice', async () => {
        const run = hold('diarize_meeting')
        renderMeeting('meeting-acme-review', '?tab=transcript')
        const dialog = renderHook(() => useDialog())
        await userEvent.click(await screen.findByRole('button', {name: 'Identify speakers…'}))
        const request = dialog.result.current.request
        act(() => {
            identifyFromSheet(request, 4)
            identifyFromSheet(request, 4)
        })
        run.release()
        expect(await screen.findByText('Found 4 speakers')).toBeInTheDocument()
        expect(run.spy).toHaveBeenCalledTimes(1)
    })

    it('closes the Identify speakers sheet when its meeting screen goes', async () => {
        const {router} = renderMeeting('meeting-acme-review', '?tab=transcript')
        const dialog = renderHook(() => useDialog())
        await userEvent.click(await screen.findByRole('button', {name: 'Identify speakers…'}))
        expect(dialog.result.current.open).toBe(true)
        await act(() => router.navigate('/'))
        expect(dialog.result.current.open).toBe(false)
    })

    it('opens the same sheet from the menu’s Identify speakers again', async () => {
        renderMeeting('meeting-acme-review')
        const dialog = renderHook(() => useDialog())
        await userEvent.click(await screen.findByRole('button', {name: /More actions/}))
        await userEvent.click(await screen.findByRole('menuitem', {name: 'Identify speakers again…'}))
        expect(dialog.result.current).toMatchObject({open: true, request: {kind: 'identify-speakers'}})
    })

    it('keeps a speaker run it started when the user leaves the meeting and comes back', async () => {
        const run = hold('diarize_meeting')
        const {router} = renderMeeting('meeting-acme-review', '?tab=transcript')
        const dialog = renderHook(() => useDialog())
        await userEvent.click(await screen.findByRole('button', {name: 'Identify speakers…'}))
        act(() => identifyFromSheet(dialog.result.current.request, 4))

        await act(() => router.navigate('/'))
        await act(() => router.navigate('/meetings/meeting-acme-review?tab=transcript'))
        expect(await screen.findByRole('button', {name: 'Identify speakers…'})).toBeDisabled()

        run.release()
        expect(await screen.findByText('Found 4 speakers')).toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('button', {name: 'Identify speakers…'})).toBeEnabled())
    })

    it('deletes the meeting after asking, and returns to the list', async () => {
        const {router} = renderMeeting('meeting-acme-review')
        await userEvent.click(await screen.findByRole('button', {name: /More actions/}))
        await userEvent.click(screen.getByRole('menuitem', {name: 'Delete…'}))
        const confirm = screen.getByRole('dialog', {name: 'Delete this meeting?'})
        expect(confirm).toHaveTextContent('Audio files stay in your recordings folder.')
        await userEvent.click(within(confirm).getByRole('button', {name: 'Delete meeting'}))
        await waitFor(() => expect(router.state.location.pathname).toBe('/'))
        expect(mockState.meetings.meetings.some((meeting) => meeting.id === 'meeting-acme-review')).toBe(false)
    })

    it('opens a named voice’s contact from its label in the transcript', async () => {
        const {router} = renderMeeting('meeting-acme-review', '?tab=transcript')
        const [label] = await screen.findAllByRole('button', {name: 'Priya Shah'})

        await userEvent.click(label)
        await userEvent.click(await screen.findByRole('menuitem', {name: 'Open Priya Shah'}))

        expect(router.state.location.pathname).toBe('/person/person-priya')
    })

    it('opens the transcript at a search result’s line, though the meeting has no audio to seek', async () => {
        const line = mockState.meetings.transcripts['meeting-acme-review'].find((entry) => entry.text.includes('data retention'))!
        const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
        renderMeeting('meeting-acme-review', `?tab=transcript&at=999&line=${line.id}`)

        const text = await screen.findByText(/a data retention statement for the recordings folder/)

        await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1))
        expect((scroll.mock.contexts[0] as HTMLElement).contains(text)).toBe(true)
    })

    it('goes to each search result inside the meeting already open, the same one again too', async () => {
        const lines = mockState.meetings.transcripts['meeting-acme-review']
        const first = lines.find((entry) => entry.text.includes('data retention'))!
        const other = lines.find((entry) => entry !== first)!
        const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
        const {router} = renderMeeting('meeting-acme-review', `?tab=transcript&line=${first.id}`)
        await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1))
        // Read and taken out of the URL, so a tab switch is not a new request.
        await waitFor(() => expect(router.state.location.search).toBe('?tab=transcript'))

        await act(() => router.navigate(`/meetings/meeting-acme-review?tab=transcript&line=${other.id}`))
        await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2))
        expect((scroll.mock.contexts[1] as HTMLElement).textContent).toContain(other.text.slice(0, 20))

        await act(() => router.navigate(`/meetings/meeting-acme-review?tab=transcript&line=${other.id}`))
        await waitFor(() => expect(scroll).toHaveBeenCalledTimes(3))
    })

    it('says so when the meeting is gone', async () => {
        renderMeeting('meeting-nowhere')
        expect(await screen.findByRole('heading', {name: 'This meeting isn’t available'})).toBeInTheDocument()
    })
})
