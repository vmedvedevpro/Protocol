import {act, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {PARAKEET_MODEL, POST_CALL_WHISPER_MODEL} from '@/api/models'
import {registerPostCallControls} from '@/api/postCall'
import {useSummaryLanguageStore} from '@/api/preferences'
import {emitMockEvent} from '@/mocks/ipc'
import {mockState} from '@/mocks/state'
import type {NativeEvent} from '@/api/events'
import {openDialog} from '@/lib/dialogs'
import {renderDialogs} from '../testing/renderDialogs'

const sheet = () => screen.findByRole('dialog', {name: 'Import a recording'})
const listened = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

/** Picks an option; the sheet is hidden from the accessibility tree until the list has gone. */
async function pick(dialog: HTMLElement, select: string, option: string) {
    await userEvent.click(within(dialog).getByRole('combobox', {name: select}))
    await userEvent.click(await screen.findByRole('option', {name: option}))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
}

async function chooseFile() {
    const dialog = await sheet()
    await listened()
    await userEvent.click(within(dialog).getByRole('button', {name: 'Choose a file'}))
    await within(dialog).findByText('client-call-nov-21.m4a')
    return dialog
}

beforeEach(() => {
    mockState.dialogs.importStepMs = 1
})

describe('ImportSheet', () => {
    it('imports a chosen file with the default model, then opens the meeting', async () => {
        const {router} = renderDialogs({kind: 'import'})
        const dialog = await chooseFile()
        expect(within(dialog).getByText('38 min · M4A')).toBeInTheDocument()
        expect(within(dialog).getByRole('textbox', {name: 'Title'})).toHaveValue('client-call-nov-21')

        await userEvent.click(within(dialog).getByRole('button', {name: 'Import'}))
        expect(await screen.findByText('Recording imported')).toBeInTheDocument()
        await waitFor(() => expect(router.state.location.pathname).toBe('/meetings/meeting-import-1'))
        expect(mockState.dialogs.imports).toEqual([{
            sourcePath: '/home/user/Recordings/client-call-nov-21.m4a',
            title: 'client-call-nov-21',
            language: null,
            model: PARAKEET_MODEL,
            provider: 'parakeet',
        }])
        await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Import a recording'})).not.toBeInTheDocument())
    })

    it('opens empty again after an import has finished, so the next one can start', async () => {
        renderDialogs({kind: 'import'})
        const dialog = await chooseFile()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Import'}))
        await screen.findByText('Recording imported')
        await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Import a recording'})).not.toBeInTheDocument())

        act(() => openDialog({kind: 'import'}))
        const again = await chooseFile()
        expect(within(again).getByRole('button', {name: 'Import'})).toBeEnabled()
        expect(screen.queryByText('One recording imports at a time')).not.toBeInTheDocument()
    })

    it('files the meeting, applies the pinned summary language and takes the title, language and model chosen', async () => {
        useSummaryLanguageStore.getState().set('de')
        renderDialogs({kind: 'import'})
        const dialog = await chooseFile()
        const title = within(dialog).getByRole('textbox', {name: 'Title'})
        await userEvent.clear(title)
        await userEvent.type(title, 'Client call')
        await pick(dialog, 'Folder', 'Acme Corp')

        await userEvent.click(within(dialog).getByRole('button', {name: 'Advanced options'}))
        expect(within(dialog).getByRole('combobox', {name: 'Language'})).toBeDisabled()
        await pick(dialog, 'Model', 'Whisper · Large V3 Turbo Compressed')
        await pick(dialog, 'Language', 'Russian')

        await userEvent.click(within(dialog).getByRole('button', {name: 'Import'}))
        await screen.findByText('Recording imported')
        expect(mockState.dialogs.imports[0]).toMatchObject({title: 'Client call', language: 'ru', provider: 'whisper', model: POST_CALL_WHISPER_MODEL})
        const meeting = mockState.meetings.meetings.find((entry) => entry.id === 'meeting-import-1')
        await waitFor(() => expect(meeting?.group_id).toBe('group-acme'))
        expect(mockState.meetings.summaryLanguages['meeting-import-1']).toBe('de')
    })

    it('hands the imported meeting to the post-call steps, even when another dialog took the sheet\'s place', async () => {
        mockState.dialogs.importStepMs = 30
        const afterImport = vi.fn()
        const unregister = registerPostCallControls({cancel: vi.fn(), retry: vi.fn(), skip: vi.fn(), afterImport, settled: () => Promise.resolve()})
        try {
            const {router} = renderDialogs({kind: 'import'})
            const dialog = await chooseFile()
            await pick(dialog, 'Folder', 'Acme Corp')
            await userEvent.click(within(dialog).getByRole('button', {name: 'Import'}))
            act(() => openDialog({kind: 'export', meetingId: 'meeting-roadmap'}))
            await waitFor(() => expect(afterImport).toHaveBeenCalledWith('meeting-import-1'))
            expect(mockState.meetings.meetings.find((entry) => entry.id === 'meeting-import-1')?.group_id).toBe('group-acme')
            await waitFor(() => expect(router.state.location.pathname).toBe('/meetings/meeting-import-1'))
        } finally {
            unregister()
        }
    })

    it('shows the progress, and Stop cancels the import', async () => {
        mockState.dialogs.importStepMs = 50
        renderDialogs({kind: 'import'})
        const dialog = await chooseFile()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Import'}))
        expect(await within(dialog).findByRole('progressbar', {name: 'Importing the recording'})).toBeInTheDocument()
        expect(await within(dialog).findByText('Copying audio file...')).toBeInTheDocument()

        await userEvent.keyboard('{Escape}')
        expect(screen.getByRole('dialog', {name: 'Import a recording'})).toBeInTheDocument()

        await userEvent.click(within(dialog).getByRole('button', {name: 'Stop'}))
        expect(await screen.findByText('Import cancelled')).toBeInTheDocument()
        await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Import a recording'})).not.toBeInTheDocument())
        expect(mockState.meetings.meetings.some((entry) => entry.id.startsWith('meeting-import'))).toBe(false)
    })

    it('says why an import failed and offers to try again', async () => {
        mockState.dialogs.importError = 'No transcription model is available'
        renderDialogs({kind: 'import'})
        const dialog = await chooseFile()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Import'}))
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('No transcription model is available')
        await userEvent.click(within(dialog).getByRole('button', {name: 'Try again'}))
        expect(await within(dialog).findByText('client-call-nov-21.m4a')).toBeInTheDocument()
        expect(within(dialog).getByRole('button', {name: 'Import'})).toBeEnabled()
    })

    it('keeps the picker when the user cancels it', async () => {
        mockState.dialogs.pickedFile = null
        renderDialogs({kind: 'import'})
        const dialog = await sheet()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Choose a file'}))
        expect(within(dialog).getByRole('button', {name: 'Import'})).toBeDisabled()
        expect(within(dialog).getByText(/MP4, M4A, WAV/)).toBeInTheDocument()
    })
})

const DRAG_ENTER = 'tauri://drag-enter' as NativeEvent<{ paths: string[] }>
const DRAG_DROP = 'tauri://drag-drop' as NativeEvent<{ paths: string[] }>

describe('dropping a file on the window', () => {
    it('dims the window while a file is over it, and opens Import with the first audio file', async () => {
        renderDialogs()
        await listened()
        await act(() => emitMockEvent(DRAG_ENTER, {paths: ['/tmp/notes.txt', '/tmp/call.mp3']}))
        expect(await screen.findByText('Drop to import this recording')).toBeInTheDocument()

        await act(() => emitMockEvent(DRAG_DROP, {paths: ['/tmp/notes.txt', '/tmp/call.mp3']}))
        const dialog = await sheet()
        expect(await within(dialog).findByText('call.mp3')).toBeInTheDocument()
        await waitFor(() => expect(screen.queryByText('Drop to import this recording')).not.toBeInTheDocument())
    })

    it('dims the window by a layer of its own and brings the text in under a veil', async () => {
        renderDialogs()
        await listened()
        await act(() => emitMockEvent(DRAG_ENTER, {paths: ['/tmp/call.mp3']}))
        const card = (await screen.findByText('Drop to import this recording')).parentElement as HTMLElement

        // Text never fades itself: only the dim beside the card and the veil in it do.
        expect(card.lastElementChild).toHaveAttribute('aria-hidden', 'true')
        for (let box = card.parentElement; box && box !== document.body; box = box.parentElement) {
            expect(box.style.opacity).toBe('')
        }
        await waitFor(() => expect((card.previousElementSibling as HTMLElement).style.opacity).toBe('1'))
    })

    it('says which formats work when nothing dropped is audio', async () => {
        renderDialogs()
        await listened()
        await act(() => emitMockEvent(DRAG_DROP, {paths: ['/tmp/notes.txt']}))
        expect(await screen.findByText('Please drop an audio file')).toBeInTheDocument()
        expect(screen.queryByRole('dialog', {name: 'Import a recording'})).not.toBeInTheDocument()
    })

    it('replaces the file of an open Import', async () => {
        renderDialogs({kind: 'import'})
        const dialog = await chooseFile()
        await act(() => emitMockEvent(DRAG_DROP, {paths: ['/tmp/standup.wav']}))
        expect(await within(dialog).findByText('standup.wav')).toBeInTheDocument()
        expect(within(dialog).getByRole('textbox', {name: 'Title'})).toHaveValue('standup')
    })
})
