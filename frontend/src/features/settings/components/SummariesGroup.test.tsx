import {createElement} from 'react'
import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {SUMMARY_LANGUAGE_DEFAULT_KEY, SUMMARY_LANGUAGE_RECENTS_KEY, useRecentSummaryLanguagesStore} from '@/api/preferences'
import {SettingsPage} from '../pages/SettingsPage'
import {renderSettings} from '../testing'

const open = () => renderSettings(createElement(SettingsPage), '/settings?section=ai')

describe('AI › Summaries', () => {
    it('pins, unpins and removes summary languages, and adds one', async () => {
        useRecentSummaryLanguagesStore.getState().set(['de', 'fr'])
        open()
        const group = await screen.findByRole('region', {name: 'Summaries'})
        expect(within(group).getByText(/Matches the language spoken in the meeting/)).toBeInTheDocument()

        await userEvent.click(within(group).getByRole('button', {name: 'Always write summaries in German'}))
        expect(localStorage.getItem(SUMMARY_LANGUAGE_DEFAULT_KEY)).toBe('de')
        expect(within(group).getByText(/Summaries are written in German/)).toBeInTheDocument()
        expect(within(group).getByRole('button', {name: 'Unpin German'})).toHaveAttribute('aria-pressed', 'true')

        await userEvent.click(within(group).getByRole('button', {name: 'Remove German'}))
        expect(localStorage.getItem(SUMMARY_LANGUAGE_DEFAULT_KEY)).toBeNull()
        expect(JSON.parse(localStorage.getItem(SUMMARY_LANGUAGE_RECENTS_KEY)!)).toEqual(['fr'])

        await userEvent.click(within(group).getByRole('combobox', {name: 'Add a summary language'}))
        await userEvent.click(await screen.findByRole('option', {name: 'Spanish'}))
        await waitFor(() => expect(JSON.parse(localStorage.getItem(SUMMARY_LANGUAGE_RECENTS_KEY)!)).toEqual(['es', 'fr']))
    })

    it('names the default template and opens the templates', async () => {
        const {router} = open()
        await userEvent.click(await screen.findByRole('button', {name: /Templates.*Standard Meeting Notes/}))
        expect(router.state.location.pathname).toBe('/settings/templates')
    })
})
