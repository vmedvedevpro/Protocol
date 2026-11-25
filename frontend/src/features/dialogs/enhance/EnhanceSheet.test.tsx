import {act, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {PARAKEET_MODEL, POST_CALL_WHISPER_MODEL} from '@/api/models'
import {handlers} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {renderDialogs} from '../testing/renderDialogs'

const sheet = () => screen.findByRole('dialog', {name: 'Improve the transcript'})
const listened = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

async function open(meetingId = 'meeting-acme-review') {
    const start = vi.spyOn(handlers, 'start_retranscription_command')
    const result = renderDialogs({kind: 'enhance', meetingId})
    const dialog = await sheet()
    await within(dialog).findByRole('combobox', {name: 'Model'})
    await listened()
    return {...result, dialog, start}
}

async function pick(dialog: HTMLElement, select: string, option: string) {
    await userEvent.click(within(dialog).getByRole('combobox', {name: select}))
    await userEvent.click(await screen.findByRole('option', {name: option}))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
}

beforeEach(() => {
    mockState.postCall.stepMs = 1
})

describe('EnhanceSheet', () => {
    it('starts from the after-meeting model and runs it again on the recording', async () => {
        mockState.speech.postCallConfig = {provider: 'whisper', model: POST_CALL_WHISPER_MODEL}
        const {dialog, start} = await open()
        expect(within(dialog).getByRole('combobox', {name: 'Model'})).toHaveTextContent('Whisper · Large V3 Turbo Compressed')
        await pick(dialog, 'Language', 'Russian')
        await userEvent.type(within(dialog).getByRole('textbox', {name: 'Words to recognize'}), 'Acme{enter}Priya Shah')
        await userEvent.click(within(dialog).getByRole('radio', {name: /This and future meetings/}))

        await userEvent.click(within(dialog).getByRole('button', {name: 'Start'}))
        expect(await screen.findByText('Transcript improved')).toBeInTheDocument()
        expect(start).toHaveBeenCalledWith({
            meetingId: 'meeting-acme-review',
            meetingFolderPath: '/preview/acme-review',
            language: 'ru',
            model: POST_CALL_WHISPER_MODEL,
            provider: 'whisper',
            vocabularyTerms: 'Acme\nPriya Shah',
            vocabularyScope: 'global',
        })
        await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Improve the transcript'})).not.toBeInTheDocument())
    })

    it('leaves the language to Parakeet, which always detects it', async () => {
        const {dialog, start} = await open()
        expect(within(dialog).getByRole('combobox', {name: 'Model'})).toHaveTextContent('Parakeet')
        expect(within(dialog).getByRole('combobox', {name: 'Language'})).toBeDisabled()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Start'}))
        await screen.findByText('Transcript improved')
        expect(start).toHaveBeenCalledWith(expect.objectContaining({language: null, provider: 'parakeet', model: PARAKEET_MODEL, vocabularyTerms: null, vocabularyScope: 'meeting'}))
    })

    it('shows the progress, holds the sheet open, and Stop cancels', async () => {
        mockState.postCall.stepMs = 40
        const {dialog} = await open()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Start'}))
        expect(await within(dialog).findByRole('progressbar', {name: 'Improving the transcript'})).toBeInTheDocument()
        await userEvent.keyboard('{Escape}')
        expect(screen.getByRole('dialog', {name: 'Improve the transcript'})).toBeInTheDocument()

        await userEvent.click(within(dialog).getByRole('button', {name: 'Stop'}))
        expect(await screen.findByText('Stopped improving the transcript')).toBeInTheDocument()
        await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Improve the transcript'})).not.toBeInTheDocument())
    })

    it('says why it could not start and offers to try again', async () => {
        mockState.postCall.retranscribing = 'meeting-roadmap'
        const {dialog} = await open()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Start'}))
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('Retranscription already in progress')
        await userEvent.click(within(dialog).getByRole('button', {name: 'Try again'}))
        expect(within(dialog).getByRole('button', {name: 'Start'})).toBeEnabled()
    })

    it('shows the words kept for this meeting and clears them', async () => {
        mockState.speech.vocabulary.meetings['meeting-acme-review'] = 'Acme\nTom Becker'
        const {dialog} = await open()
        expect(await within(dialog).findByText('Already kept for this meeting')).toBeInTheDocument()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Clear'}))
        await waitFor(() => expect(within(dialog).queryByText('Already kept for this meeting')).not.toBeInTheDocument())
        expect(mockState.speech.vocabulary.meetings['meeting-acme-review']).toBe('')
    })

    it('offers Whisper from Settings when none is downloaded', async () => {
        mockState.models.whisper[POST_CALL_WHISPER_MODEL] = 'Missing'
        const {dialog, router} = await open()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Get Whisper…'}))
        expect(router.state.location.pathname).toBe('/settings')
        expect(router.state.location.search).toBe('?section=transcription')
    })
})
