import {createElement} from 'react'
import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {SettingsPage} from '../pages/SettingsPage'
import {indexedLabels} from '../pages/settingsPages'
import {renderedRowLabels, renderSettings} from '../testing'

const open = () => renderSettings(createElement(SettingsPage), '/settings/templates')

describe('Summary templates page', () => {
    it('changes the default template at once and shows its sections', async () => {
        open()
        const templates = await screen.findByRole('radiogroup', {name: 'Default template'})
        expect(await within(templates).findByRole('radio', {name: 'Standard Meeting Notes'})).toBeChecked()
        const sections = await screen.findByRole('region', {name: 'Sections'})
        expect(await within(sections).findByText('Summary')).toBeInTheDocument()

        const order = () => within(templates).getAllByRole('radio').map((radio) => radio.getAttribute('aria-label') ?? radio.textContent)
        const before = order()
        await userEvent.click(within(templates).getByRole('radio', {name: 'Daily Standup'}))
        await waitFor(() => expect(mockState.templates.defaultId).toBe('daily_standup'))
        expect(within(templates).getByRole('radio', {name: 'Daily Standup'})).toBeChecked()
        // The row clicked stays under the pointer: the order is by name (#218).
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(order()).toEqual(before)
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

    it('shows the rows its search index lists', async () => {
        mockState.templates.custom.board = {...mockState.templates.builtIn.standard_meeting, name: 'Board review'}
        mockState.templates.defaultId = 'board'
        open()
        await screen.findByRole('button', {name: 'Delete'})
        const templates = [...Object.values(mockState.templates.builtIn), ...Object.values(mockState.templates.custom)]
        const data = templates.flatMap(({name, sections}) => [name, ...sections.map(({title}) => title)])
        expect(renderedRowLabels(data)).toEqual([...indexedLabels('templates')].sort())
    })
})
