import {createElement} from 'react'
import {configure, getConfig, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {renderSettings} from '../testing'
import {SettingsPage} from './SettingsPage'

const open = () => renderSettings(createElement(SettingsPage), '/settings?section=general')
const search = () => screen.findByRole('searchbox', {name: 'Search settings'})

describe('Settings search', () => {
    it('finds rows in every section under the section’s name', async () => {
        open()
        await userEvent.type(await search(), 'summar')

        const summaries = await screen.findByRole('region', {name: 'AI · Summaries'})
        expect(within(summaries).getByRole('switch', {name: 'Summarize automatically'})).toBeInTheDocument()
        expect(within(summaries).getByRole('button', {name: /Summary model/})).toBeInTheDocument()
        expect(screen.queryByRole('region', {name: /General · You/})).not.toBeInTheDocument()
    })

    it('finds the rows of the pages and opens the page', async () => {
        const {router} = open()
        await userEvent.type(await search(), 'openrouter')

        const pages = await screen.findByRole('region', {name: 'Pages'})
        await userEvent.click(within(pages).getByRole('button', {name: /Summary model/}))
        expect(router.state.location.pathname).toBe('/settings/summary-model')
    })

    it('says when nothing matches, and Escape brings the section back', async () => {
        open()
        const field = await search()
        await userEvent.type(field, 'zzzz')
        expect(await screen.findByText('Nothing matches “zzzz”.')).toBeInTheDocument()

        await userEvent.keyboard('{Escape}')
        expect(field).toHaveValue('')
        expect(await screen.findByRole('region', {name: 'You'})).toBeInTheDocument()
    })

    it('keeps every key typed while the first results render', async () => {
        open()
        const field = await search()
        // Testing Library wraps each event in act(), which commits the
        // router's transition before the next key. A real keyboard does not
        // wait for it, so the keys go in without that wrapper.
        const {eventWrapper} = getConfig()
        configure({eventWrapper: (dispatch) => dispatch()})
        try {
            await userEvent.setup({delay: null}).type(field, 'model')
        } finally {
            configure({eventWrapper})
        }
        await waitFor(() => expect(screen.getByRole('region', {name: 'Pages'})).toBeInTheDocument())
        expect(field).toHaveValue('model')
    })

    it('leaves the search for a section picked', async () => {
        open()
        const field = await search()
        await userEvent.type(field, 'model')
        await userEvent.click(screen.getByRole('tab', {name: 'Recording'}))
        expect(field).toHaveValue('')
    })
})
