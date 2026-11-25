import {act, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {QueryClientProvider} from '@tanstack/react-query'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {describe, expect, it, vi} from 'vitest'
import {openSearch, useSearchLauncher} from '@/lib/searchLauncher'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'
import {useThemeModeStore} from '@/styles/themeMode'
import {type SearchCommand, SearchDialog} from './SearchDialog'

function renderSearch(actions: SearchCommand[] = []) {
    const router = createMemoryRouter([{path: '*', element: <SearchDialog actions={actions}/>}], {initialEntries: ['/']})
    renderUi(<QueryClientProvider client={createTestQueryClient()}><RouterProvider router={router}/></QueryClientProvider>)
    return router
}

const groupNames = () => screen.getAllByRole('group').map((group) => group.getAttribute('aria-labelledby'))
    .map((id) => document.getElementById(id ?? '')?.textContent)

describe('SearchDialog', () => {
    it('opens on ⌘K with the commands and recent meetings, and closes on Escape', async () => {
        const record = vi.fn()
        renderSearch([{id: 'record', label: 'Start recording', icon: null, run: record}])

        await userEvent.keyboard('{Control>}k{/Control}')
        const dialog = await screen.findByRole('dialog', {name: 'Search and commands'})

        expect(within(dialog).getByRole('combobox', {name: 'Search meetings, people and commands'})).toHaveFocus()
        await waitFor(() => expect(groupNames()).toEqual(['Actions', 'Recent meetings', 'People', 'Go to', 'Theme']))
        expect(screen.getByRole('option', {name: /Acme pilot security review/})).toBeInTheDocument()
        await userEvent.keyboard('{Escape}')
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(record).not.toHaveBeenCalled()
    })

    it('searches the library when typing pauses, grouped by native’s ranking, and opens a line at its moment', async () => {
        const router = renderSearch()
        act(() => openSearch())

        await userEvent.type(await screen.findByRole('combobox'), 'retention')

        await screen.findByRole('option', {name: /a data retention statement for the recordings folder/})
        expect(groupNames()).toEqual(['Said in a meeting', 'In a summary'])
        expect(screen.getByRole('option', {name: /Sam Rivera · .* · Acme pilot security review/})).toBeInTheDocument()
        // A summary's snippet is cut from its Markdown; the row shows only the words.
        const inSummary = within(screen.getByRole('group', {name: 'In a summary'})).getAllByRole('option')
        for (const row of inSummary) expect(row.textContent).not.toMatch(/\||#|\*\*/)
        // The first row is lit; Enter opens it on the transcript at the line, and
        // the player at its moment when the meeting has audio.
        await userEvent.keyboard('{Enter}')
        expect(router.state.location.pathname).toBe('/meetings/meeting-acme-review')
        expect(router.state.location.search).toMatch(/^\?tab=transcript&at=\d+&line=[\w-]+$/)
        await waitFor(() => expect(useSearchLauncher.getState().open).toBe(false))
    })

    it('opens a person, a folder and an action item in its summary where they live', async () => {
        const router = renderSearch()

        act(() => openSearch('Marcus'))
        await userEvent.click(await screen.findByRole('option', {name: /^Marcus Lee/}))
        await waitFor(() => expect(router.state.location.pathname).toBe('/person/person-marcus'))

        // An action item is part of its summary's text (#218): it is found
        // there. Wait for this query's rows, which replace the last query's.
        act(() => openSearch('scope the audio player'))
        await waitFor(() => expect(screen.queryByRole('option', {name: /^Marcus Lee/})).not.toBeInTheDocument())
        expect(screen.queryByRole('group', {name: 'Action items'})).not.toBeInTheDocument()
        await userEvent.click(await screen.findByRole('option', {name: /scope the audio player work.*Q4 roadmap planning/}))
        await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/meetings/meeting-roadmap?tab=summary'))

        act(() => openSearch('acme corp'))
        await userEvent.click(await screen.findByRole('option', {name: /^Acme Corp/}))
        await waitFor(() => expect(router.state.location.search).toBe('?folder=group-acme'))
    })

    it('finds commands by their words and runs one once the dialog has closed', async () => {
        const run = vi.fn(() => expect(useSearchLauncher.getState().open).toBe(false))
        renderSearch([{id: 'new-folder', label: 'New folder', keywords: 'group customer', icon: null, run}])
        act(() => openSearch('customer'))

        await userEvent.click(await screen.findByRole('option', {name: 'New folder'}))

        await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    })

    it('switches the theme with the dialog still open', async () => {
        renderSearch()
        act(() => openSearch('dark'))

        await userEvent.click(await screen.findByRole('option', {name: 'Dark'}))

        expect(useThemeModeStore.getState().mode).toBe('dark')
        expect(await screen.findByRole('option', {name: /^Dark ?, current$/})).toBeInTheDocument()
        expect(useSearchLauncher.getState().open).toBe(true)
    })

    it('says when nothing matches, and asks for one more letter', async () => {
        renderSearch()
        act(() => openSearch('q'))
        expect(await screen.findByText('Type another letter to search your meetings.')).toBeInTheDocument()

        await userEvent.type(screen.getByRole('combobox'), 'zxqv')

        expect(await screen.findByText('Nothing found for “qzxqv”.')).toBeInTheDocument()
    })

    it('moves the lit row in the same frame as the key, with no colour fade', async () => {
        renderSearch()
        act(() => openSearch())
        await waitFor(() => expect(groupNames()).toEqual(['Recent meetings', 'People', 'Go to', 'Theme']))
        const rows = screen.getAllByRole('option')

        await userEvent.keyboard('{ArrowDown}')

        // A palette driven by the keyboard changes in place: a fade would leave two rows half lit.
        await waitFor(() => expect(rows[1]).toHaveAttribute('aria-selected', 'true'))
        for (const row of rows.slice(0, 2)) expect(getComputedStyle(row).transitionProperty).not.toMatch(/background/)
    })

    describe('people', () => {
        const options = (group: string) => within(screen.getByRole('group', {name: group})).getAllByRole('option')
        const names = (group: string) => options(group).map((option) => option.querySelector('span > span')?.textContent)

        it('lists a few contacts after the recent meetings, by their latest meeting, and the rest on Show all people', async () => {
            const router = renderSearch()
            act(() => openSearch())
            await waitFor(() => expect(groupNames()).toEqual(['Recent meetings', 'People', 'Go to', 'Theme']))
            const shown = names('People')
            expect(shown).toHaveLength(5)
            expect(shown.at(-1)).toBe('Show all people')
            // The keyboard walks the groups in their order: the last recent meeting, then the first contact.
            const all = screen.getAllByRole('option')
            expect(all.indexOf(options('People')[0])).toBe(options('Recent meetings').length)

            await userEvent.click(screen.getByRole('option', {name: /^Show all people/}))
            await waitFor(() => expect(groupNames()).toEqual(['People']))
            expect(names('People')).toHaveLength(mockState.people.rows.length)
            expect(screen.getByRole('combobox')).toHaveAttribute('placeholder', 'Filter people by name, role, company or email')
            // Clicked with the pointer, the row hands the focus back to the field the filter is typed in.
            expect(screen.getByRole('combobox')).toHaveFocus()

            await userEvent.click(screen.getByRole('option', {name: /^Tom Becker/}))
            await waitFor(() => expect(router.state.location.pathname).toBe('/person/person-tom'))
        })

        it('shows a contact’s role and company, else their meetings', async () => {
            mockState.people.rows.push({id: 'person-new', displayName: 'Dana Wu'})
            renderSearch()
            act(() => openSearch())
            await userEvent.click(await screen.findByRole('option', {name: /^Show all people/}))
            expect(await screen.findByRole('option', {name: /^Tom Becker\s*IT Director, Acme Corp$/})).toBeInTheDocument()
            expect(screen.getByRole('option', {name: /^Dana Wu\s*0 meetings$/})).toBeInTheDocument()
        })

        it('filters the full list by name, role, company and email, and Backspace goes back', async () => {
            renderSearch()
            act(() => openSearch('contacts'))
            await userEvent.click(await screen.findByRole('option', {name: 'People'}))
            await waitFor(() => expect(groupNames()).toEqual(['People']))
            const field = screen.getByRole('combobox')
            expect(field).toHaveValue('')

            await userEvent.type(field, 'acme')
            expect(names('People').sort()).toEqual(['Sam Rivera', 'Tom Becker'])
            await userEvent.clear(field)
            await userEvent.type(field, 'design lead')
            expect(names('People')).toEqual(['Elena García'])
            await userEvent.clear(field)
            await userEvent.type(field, 'priya@')
            expect(names('People')).toEqual(['Priya Shah'])
            await userEvent.clear(field)
            await userEvent.type(field, 'nobody')
            expect(screen.getByText('No one matches “nobody”.')).toBeInTheDocument()

            await userEvent.clear(field)
            await userEvent.keyboard('{Backspace}')
            await waitFor(() => expect(groupNames()).toEqual(['Recent meetings', 'People', 'Go to', 'Theme']))
        })

        it('finds the command by typing people', async () => {
            renderSearch()
            act(() => openSearch('people'))
            expect(await screen.findByRole('option', {name: 'People'})).toBeInTheDocument()
        })

        it('leaves the group out without contacts', async () => {
            mockState.people.rows = []
            renderSearch()
            act(() => openSearch())
            await waitFor(() => expect(groupNames()).toEqual(['Recent meetings', 'Go to', 'Theme']))
            expect(screen.queryByRole('option', {name: /Show all people/})).not.toBeInTheDocument()
        })
    })
})
