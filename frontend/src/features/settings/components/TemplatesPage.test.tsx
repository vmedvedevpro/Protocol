import {createElement} from 'react'
import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {SettingsPage} from '../pages/SettingsPage'
import {renderSettings} from '../testing'

const open = () => renderSettings(createElement(SettingsPage), '/settings/templates')

describe('Summary templates page', () => {
    it('changes the default template at once and shows its sections', async () => {
        open()
        const templates = await screen.findByRole('radiogroup', {name: 'Default template'})
        expect(await within(templates).findByRole('radio', {name: 'Standard Meeting Notes'})).toBeChecked()
        const sections = await screen.findByRole('region', {name: 'Sections'})
        expect(await within(sections).findByText('Summary')).toBeInTheDocument()

        await userEvent.click(within(templates).getByRole('radio', {name: 'Daily Standup'}))
        await waitFor(() => expect(mockState.templates.defaultId).toBe('daily_standup'))
        expect(within(templates).getByRole('radio', {name: 'Daily Standup'})).toBeChecked()
    })

    it('deletes the user’s own default template, and native falls back', async () => {
        mockState.templates.custom.board = {...mockState.templates.builtIn.standard_meeting, name: 'Board review'}
        mockState.templates.defaultId = 'board'
        open()
        const templates = await screen.findByRole('radiogroup', {name: 'Default template'})
        expect(await within(templates).findByRole('radio', {name: /Board review/})).toBeChecked()

        await userEvent.click(await screen.findByRole('button', {name: 'Delete'}))
        await waitFor(() => expect(within(templates).queryByRole('radio', {name: /Board review/})).not.toBeInTheDocument())
        expect(await within(templates).findByRole('radio', {name: 'Standard Meeting Notes'})).toBeChecked()
    })
})
