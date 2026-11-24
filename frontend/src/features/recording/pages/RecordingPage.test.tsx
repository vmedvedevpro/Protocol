import {act, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {speakMockLine} from '@/mocks/live'
import {mockState} from '@/mocks/state'
import {RecordingRuntime} from '../components/RecordingRuntime'
import {setLiveNotes} from '../store/liveNotes'
import {session} from '../store/session'
import {startRecording} from '../store/start'
import {renderRecording} from '../test/renderRecording'
import {RecordingPage} from './RecordingPage'

const renderPage = () => renderRecording(<><RecordingRuntime/><RecordingPage/></>)

async function recording(lines = 0) {
    renderPage()
    await startRecording()
    for (let line = 0; line < lines; line++) speakMockLine(mockState)
    if (lines) await waitFor(() => expect(session.get().lines).toHaveLength(lines))
}

describe('RecordingPage', () => {
    it('says how to start while nothing records', async () => {
        renderPage()
        expect(screen.getByRole('heading', {level: 1, name: 'Recording'})).toBeInTheDocument()
        expect(screen.getByText('Not recording')).toBeInTheDocument()
    })

    it('shows the live transcript, and names a voice on every line of it', async () => {
        await recording(3)
        await userEvent.click(screen.getByRole('tab', {name: 'Transcript'}))

        const transcript = await screen.findByRole('region', {name: 'Live transcript'})
        expect(within(transcript).getByText(/Morning everyone/)).toBeInTheDocument()
        expect(screen.getByText('3 voices')).toBeInTheDocument()

        await userEvent.click(within(transcript).getByRole('button', {name: /Speaker 2/}))
        await userEvent.keyboard('Priya{Enter}')
        await waitFor(() => expect(session.get().lines[1].speaker).toBe('Priya'))
        // A line still to come keeps the name.
        speakMockLine(mockState)
        speakMockLine(mockState)
        await waitFor(() => expect(session.get().lines.map((line) => line.speaker)).toEqual(['You', 'Priya', 'Speaker 3', 'You', 'Priya']))
    })

    it('mounts the notes from the latest edit when the Notes view comes back', async () => {
        await recording()
        expect(await screen.findByRole('textbox', {name: 'Notes'})).toBeInTheDocument()
        expect(screen.getByText('Notes merge with the transcript when you stop.')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('tab', {name: 'Transcript'}))
        // What the editor reports on an edit (jsdom cannot type into ProseMirror).
        act(() => setLiveNotes({markdown: 'Ship it on Friday', json: []}))
        await userEvent.click(screen.getByRole('tab', {name: 'Notes'}))

        expect(await screen.findByRole('textbox', {name: 'Notes'})).toHaveTextContent('Ship it on Friday')
    })

    it('summarizes the transcript so far', async () => {
        await recording(2)
        await userEvent.click(screen.getByRole('tab', {name: 'Summary'}))
        expect(screen.getByText('Summary is written when you stop')).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Summarize so far'}))

        const answer = await screen.findByRole('region', {name: 'Summary so far'})
        expect(await within(answer).findByText(/Design review is Thursday/)).toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Summarize again'})).toBeInTheDocument()
    })

    it('pauses with Space and switches views with the number keys', async () => {
        await recording()
        await screen.findByRole('tab', {name: 'Notes', selected: true})
        ;(document.activeElement as HTMLElement | null)?.blur()

        await userEvent.keyboard(' ')
        await waitFor(() => expect(session.get().phase).toBe('paused'))

        await userEvent.keyboard('{Control>}[Digit2]{/Control}')
        expect(screen.getByRole('tab', {name: 'Transcript', selected: true})).toBeInTheDocument()
    })

    it('renames the recording and files it in a folder', async () => {
        await recording()
        await userEvent.click(screen.getByRole('button', {name: /^Meeting · /}))
        const field = screen.getByRole('textbox', {name: 'Title'})
        await userEvent.clear(field)
        await userEvent.type(field, 'Release sync{Enter}')
        expect(screen.getByRole('heading', {level: 1, name: 'Release sync'})).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Folder: No folder. Change'}))
        await userEvent.click(await screen.findByRole('menuitemradio', {name: mockState.meetings.folders[0].name}))
        expect(session.get()).toMatchObject({folder: {id: mockState.meetings.folders[0].id}, title: 'Release sync', titleManual: true})
    })
})
