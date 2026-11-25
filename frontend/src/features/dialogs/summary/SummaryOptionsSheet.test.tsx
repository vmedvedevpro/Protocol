import {renderHook, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {useDialog} from '@/lib/dialogs'
import {handlers, type MockArgs} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {renderDialogs} from '../testing/renderDialogs'

const MEETING = 'meeting-roadmap'

async function open() {
    const run = vi.spyOn(handlers, 'api_process_transcript')
    const result = renderDialogs({kind: 'summary', meetingId: MEETING})
    const dialog = await screen.findByRole('dialog', {name: 'Summary options'})
    await within(dialog).findByRole('combobox', {name: 'Template'})
    return {...result, dialog, run}
}

async function pick(dialog: HTMLElement, select: string, option: string) {
    await userEvent.click(within(dialog).getByRole('combobox', {name: select}))
    await userEvent.click(await screen.findByRole('option', {name: option}))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
}

describe('SummaryOptionsSheet', () => {
    it('writes again with the template, language and instructions chosen', async () => {
        const {dialog, run} = await open()
        expect(within(dialog).getByRole('combobox', {name: 'Template'})).toHaveTextContent('Standard Meeting Notes')
        expect(within(dialog).getByRole('combobox', {name: 'Language'})).toHaveTextContent('Same as the transcript')
        await pick(dialog, 'Template', 'Daily Standup')
        await pick(dialog, 'Language', 'German')
        await userEvent.type(within(dialog).getByRole('textbox', {name: 'Write it again'}), 'Only the decisions')

        await userEvent.click(within(dialog).getByRole('button', {name: 'Write again'}))
        await waitFor(() => expect(run).toHaveBeenCalled())
        expect(run.mock.calls[0][0]).toMatchObject({templateId: 'daily_standup', customPrompt: 'Only the decisions', summaryLanguage: 'de'})
        expect(mockState.meetings.summaryLanguages[MEETING]).toBe('de')
        await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Summary options'})).not.toBeInTheDocument())
    })

    it('writes on Ctrl Enter in the instructions', async () => {
        const {dialog, run} = await open()
        await userEvent.type(within(dialog).getByRole('textbox', {name: 'Write it again'}), 'Short{Control>}{Enter}{/Control}')
        await waitFor(() => expect(run).toHaveBeenCalled())
        expect(run.mock.calls[0][0]).toMatchObject({customPrompt: 'Short'})
    })

    it('starts once when Ctrl Enter is pressed twice quickly', async () => {
        const {dialog, run} = await open()
        // The first start is still saving the language when the second press comes.
        const original = handlers.api_save_meeting_summary_language
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const saveLanguage = vi.spyOn(handlers, 'api_save_meeting_summary_language').mockImplementation(async (args: MockArgs) => {
            await gate
            return original(args)
        })
        await pick(dialog, 'Language', 'German')
        await userEvent.type(within(dialog).getByRole('textbox', {name: 'Write it again'}), '{Control>}{Enter}{Enter}{/Control}')
        release()

        await waitFor(() => expect(run).toHaveBeenCalled())
        expect(saveLanguage).toHaveBeenCalledTimes(1)
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('says that edits are replaced, and stays open when no model is chosen', async () => {
        mockState.meetings.summaries[MEETING].userEdited = true
        mockState.preferences.summaryModel = null
        const {dialog, run} = await open()
        expect(within(dialog).getByText(/replaces your edits/)).toBeInTheDocument()
        expect(within(dialog).getByText('No summary model is chosen')).toBeInTheDocument()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Write again'}))
        expect(await screen.findByText('Choose a summary model')).toBeInTheDocument()
        expect(run).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog', {name: 'Summary options'})).toBeInTheDocument()
    })

    it('opens the summary model page from Change', async () => {
        const {dialog, router} = await open()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Change'}))
        expect(router.state.location.pathname).toBe('/settings/summary-model')
    })

    it('edits the chosen template and comes back to it', async () => {
        const {dialog} = await open()
        const template = renderHook(() => useDialog())
        await pick(dialog, 'Template', 'Daily Standup')
        await userEvent.click(within(dialog).getByRole('button', {name: 'Edit templates…'}))
        expect(template.result.current.request).toMatchObject({templateId: 'daily_standup', returnTo: {kind: 'summary', meetingId: MEETING}})
    })
})
