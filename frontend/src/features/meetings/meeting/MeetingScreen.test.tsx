import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {beforeEach, describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {renderRoute} from '../testing'
import {MeetingRoute} from './MeetingScreen'

const renderMeeting = (meetingId: string, query = '') => renderRoute(`/meetings/${meetingId}${query}`, [
    {path: '/', element: <p>Home</p>},
    {path: '/meetings/:meetingId', element: <MeetingRoute/>},
])

beforeEach(() => {
    mockState.meetings.summaryRunMs = 20
    mockState.postCall.stepMs = 1
})

describe('MeetingScreen', () => {
    it('shows the title, when it was, how long and its folder', async () => {
        renderMeeting('meeting-acme-review')
        expect(await screen.findByRole('heading', {level: 1, name: 'Acme pilot security review'})).toBeInTheDocument()
        await waitFor(() => expect(screen.getByText(/^Today, .* · \d+ min · Acme Corp$/)).toBeInTheDocument())
    })

    it('opens on the summary, its action section moved into action items', async () => {
        renderMeeting('meeting-acme-review')
        const items = await screen.findByRole('region', {name: 'Action items'})
        await waitFor(() => expect(within(items).getByText(/Prepare a local-models-only configuration/)).toBeInTheDocument())
        expect(items).toHaveTextContent('· Priya Shah · Friday')
        expect(mockState.meetings.summaries['meeting-acme-review'].data).not.toMatchObject({markdown: expect.stringContaining('## Action items')})
        expect(screen.getByText('Written from the transcript.')).toBeInTheDocument()
    })

    it('checks off, adds and deletes action items', async () => {
        renderMeeting('meeting-acme-review')
        const items = await screen.findByRole('region', {name: 'Action items'})
        const box = await within(items).findByRole('checkbox', {name: /Prepare a local-models-only/})
        await userEvent.click(box)
        await waitFor(() => expect(box).toBeChecked())

        await userEvent.click(within(items).getByRole('button', {name: 'Add an action item'}))
        await userEvent.type(screen.getByRole('textbox', {name: 'What needs doing'}), 'Book the pilot kickoff')
        await userEvent.click(screen.getByRole('button', {name: 'Add'}))
        const added = await within(items).findByRole('button', {name: 'Book the pilot kickoff · no owner yet'})

        await userEvent.click(added)
        await userEvent.click(screen.getByRole('button', {name: 'Delete'}))
        await waitFor(() => expect(within(items).queryByText('Book the pilot kickoff')).not.toBeInTheDocument())
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
        renderMeeting('meeting-untitled')
        await userEvent.click(await screen.findByRole('button', {name: 'Generate summary'}))
        expect(await screen.findByText('Writing the summary…')).toBeInTheDocument()
        expect(await screen.findByRole('region', {name: 'Action items'}, {timeout: 3000})).toBeInTheDocument()
        expect(mockState.meetings.summaries['meeting-untitled'].status).toBe('completed')
    })

    it('asks for a summary model first when none is chosen', async () => {
        mockState.preferences.summaryModel = null
        renderMeeting('meeting-untitled')
        await userEvent.click(await screen.findByRole('button', {name: 'Generate summary'}))
        expect(await screen.findByText('Choose a summary model')).toBeInTheDocument()
        expect(mockState.meetings.summaries['meeting-untitled']).toBeUndefined()
    })

    it('asks before writing again over the user’s edits', async () => {
        mockState.meetings.summaries['meeting-roadmap'].userEdited = true
        renderMeeting('meeting-roadmap')
        await userEvent.click(await screen.findByRole('button', {name: 'Write the summary again'}))
        const confirm = screen.getByRole('dialog', {name: 'Write the summary again?'})
        expect(confirm).toHaveTextContent('replaces your edits')
        await userEvent.click(within(confirm).getByRole('button', {name: 'Write again'}))
        await waitFor(() => expect(mockState.meetings.summaries['meeting-roadmap'].status).not.toBe('completed'))
    })

    it('copies the transcript with times and speakers', async () => {
        const user = userEvent.setup()
        renderMeeting('meeting-acme-review')
        await user.click(await screen.findByRole('button', {name: /More actions/}))
        await user.click(screen.getByRole('menuitem', {name: 'Copy transcript'}))
        await screen.findByText('Transcript copied')
        const copied = await navigator.clipboard.readText()
        expect(copied).toMatch(/^# Acme pilot security review\n\n_.+_\n\n## Transcript\n\n\[\d\d:\d\d\] \*\*/)
    })

    it('moves the meeting to another folder', async () => {
        renderMeeting('meeting-acme-review')
        await userEvent.click(await screen.findByRole('button', {name: /More actions/}))
        await userEvent.click(screen.getByRole('menuitem', {name: 'Move to folder'}))
        await userEvent.click(await screen.findByRole('menuitemradio', {name: 'Design Team'}))
        await waitFor(() => expect(screen.getByText(/· Design Team$/)).toBeInTheDocument())
    })

    it('identifies the speakers again with a count', async () => {
        renderMeeting('meeting-acme-review', '?tab=transcript')
        await userEvent.click(await screen.findByRole('button', {name: /speakers found\. Change the count/}))
        await userEvent.click(screen.getByRole('menuitem', {name: '4 speakers'}))
        expect(await screen.findByText('Found 4 speakers')).toBeInTheDocument()
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

    it('says so when the meeting is gone', async () => {
        renderMeeting('meeting-nowhere')
        expect(await screen.findByRole('heading', {name: 'This meeting isn’t available'})).toBeInTheDocument()
    })
})
