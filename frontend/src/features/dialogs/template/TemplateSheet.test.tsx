import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {renderDialogs} from '../testing/renderDialogs'

describe('TemplateSheet', () => {
    it('saves a built-in template as the user’s own copy, sections in order', async () => {
        renderDialogs({kind: 'template', templateId: 'daily_standup'})
        const dialog = await screen.findByRole('dialog', {name: 'Edit template'})
        const name = await within(dialog).findByRole('textbox', {name: 'Name'})
        expect(name).toHaveValue('Daily Standup')
        const count = mockState.templates.builtIn.daily_standup.sections.length
        expect(within(dialog).getAllByRole('textbox', {name: 'Section title'})).toHaveLength(count)

        const first = within(dialog).getAllByRole('button', {name: /^Remove /})[0]
        await userEvent.click(first)
        await userEvent.click(within(dialog).getByRole('button', {name: 'Save template'}))
        expect(await screen.findByText('Template “Daily Standup” saved')).toBeInTheDocument()
        expect(mockState.templates.custom.daily_standup.sections).toHaveLength(count - 1)
        await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Edit template'})).not.toBeInTheDocument())
    })

    it('creates a template and says what is missing first', async () => {
        renderDialogs({kind: 'template'})
        const dialog = await screen.findByRole('dialog', {name: 'New template'})
        await userEvent.type(within(dialog).getByRole('textbox', {name: 'Name'}), 'Client call')
        await userEvent.click(within(dialog).getByRole('button', {name: 'Save template'}))
        expect(within(dialog).getByRole('alert')).toHaveTextContent('Say what the template is for.')

        await userEvent.type(within(dialog).getByRole('textbox', {name: 'Description'}), 'Calls with clients')
        await userEvent.type(within(dialog).getByRole('textbox', {name: 'Section title'}), 'Next steps')
        await userEvent.type(within(dialog).getByRole('textbox', {name: 'Instruction for Next steps'}), 'List what happens next.')
        await userEvent.click(within(dialog).getByRole('button', {name: 'Add section'}))
        await userEvent.click(within(dialog).getByRole('button', {name: 'Remove section 2'}))
        await userEvent.click(within(dialog).getByRole('button', {name: 'Save template'}))
        await screen.findByText('Template “Client call” saved')
        expect(mockState.templates.custom.client_call).toEqual({
            name: 'Client call',
            description: 'Calls with clients',
            sections: [{title: 'Next steps', instruction: 'List what happens next.', format: 'list'}],
        })
    })

    it('refuses a new name that another template has', async () => {
        renderDialogs({kind: 'template'})
        const dialog = await screen.findByRole('dialog', {name: 'New template'})
        await userEvent.type(within(dialog).getByRole('textbox', {name: 'Name'}), 'Daily standup')
        await userEvent.click(within(dialog).getByRole('button', {name: 'Save template'}))
        expect(within(dialog).getByRole('alert')).toHaveTextContent('A template with this name exists')
    })

    it('goes back to Summary options on the template saved', async () => {
        renderDialogs({kind: 'template', templateId: 'retrospective', returnTo: {kind: 'summary', meetingId: 'meeting-roadmap'}})
        const dialog = await screen.findByRole('dialog', {name: 'Edit template'})
        await within(dialog).findByRole('textbox', {name: 'Name'})
        await userEvent.click(within(dialog).getByRole('button', {name: 'Save template'}))
        const options = await screen.findByRole('dialog', {name: 'Summary options'})
        expect(await within(options).findByRole('combobox', {name: 'Template'})).toHaveTextContent(mockState.templates.builtIn.retrospective.name)
    })
})
