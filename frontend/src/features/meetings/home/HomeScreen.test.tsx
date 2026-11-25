import {renderHook, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {useModelDownloadSync} from '@/api/modelDownloadSync'
import {useDialog} from '@/lib/dialogs'
import {useSearchLauncher} from '@/lib/searchLauncher'
import {mockState} from '@/mocks/state'
import {playAnimations, watchStyles} from '@/test/motion'
import {renderRoute} from '../testing'
import {HomeScreen} from './HomeScreen'

const renderHome = (url = '/') => renderRoute(url, [{path: '/', element: <HomeScreen/>}])

/** Home with the downloads kept current from their events, as the shell does. */
function HomeWithDownloads() {
    useModelDownloadSync()
    return <HomeScreen/>
}

const rowTitles = () => screen.queryAllByRole('link').map((link) => link.querySelector('span')?.textContent)

const downloadedOffer = () => {
    mockState.updater = {
        ...mockState.updater,
        support: {kind: 'updatable', install: 'nsis'},
        offer: {release: {version: '0.9.0', notes: '### Changed\n\n- **Faster summaries.**', date: null}, downloaded: true, manualOnly: false, waitingForRecording: false},
    }
}

describe('HomeScreen', () => {
    it('lists the meetings newest first, in sections by date', async () => {
        renderHome()
        const today = await screen.findByRole('region', {name: 'Today'})
        expect(within(today).getByRole('link', {name: /Acme pilot security review/})).toHaveAttribute('href', '/meetings/meeting-acme-review')
        // The folder is the second line.
        expect(within(today).getByRole('link', {name: /Acme pilot security review/})).toHaveTextContent('Acme Corp')
        expect(screen.getByRole('region', {name: 'Yesterday'})).toHaveTextContent('Q4 roadmap planning')
    })

    it('takes the words to search for transcripts, summaries and people', async () => {
        renderHome()
        const search = await screen.findByRole('searchbox', {name: 'Search meetings'})

        await userEvent.type(search, 'retention')
        await userEvent.click(await screen.findByRole('button', {name: /Search transcripts, summaries and people for “retention”/}))
        expect(useSearchLauncher.getState()).toEqual({open: true, query: 'retention'})

        useSearchLauncher.setState({open: false, query: ''})
        await userEvent.type(search, '{Enter}')
        expect(useSearchLauncher.getState()).toEqual({open: true, query: 'retention'})
    })

    it('filters by title and by folder name as the user types, and Escape clears it', async () => {
        renderHome()
        await screen.findByRole('region', {name: 'Today'})
        const search = screen.getByRole('searchbox', {name: 'Search meetings'})

        await userEvent.type(search, 'roadmap')
        expect(rowTitles()).toEqual(['Q4 roadmap planning'])

        await userEvent.clear(search)
        await userEvent.type(search, 'design team')
        expect(rowTitles()).toEqual(['Onboarding flow critique', 'Design system sync'])

        await userEvent.clear(search)
        await userEvent.type(search, 'nothing like this')
        expect(screen.getByText('No meetings match “nothing like this”.')).toBeInTheDocument()

        await userEvent.keyboard('{Escape}')
        expect(search).toHaveValue('')
        expect(rowTitles().length).toBeGreaterThan(5)
    })

    it('filters by folder and keeps the folder in the URL', async () => {
        const {router} = renderHome()
        await userEvent.click(await screen.findByRole('button', {name: 'Design Team'}))
        expect(rowTitles()).toEqual(['Onboarding flow critique', 'Design system sync'])
        expect(router.state.location.search).toBe('?folder=group-design')
        expect(screen.getByRole('button', {name: 'Design Team'})).toHaveAttribute('aria-pressed', 'true')

        await userEvent.click(screen.getByRole('button', {name: 'All'}))
        expect(router.state.location.search).toBe('')
    })

    it('creates a folder and shows it', async () => {
        const {router} = renderHome()
        await userEvent.click(await screen.findByRole('button', {name: 'New folder'}))
        await userEvent.type(screen.getByRole('textbox', {name: 'Name'}), 'Hiring{Enter}')

        const chip = await screen.findByRole('button', {name: 'Hiring'})
        // The chip shows before the new folder is selected; under load the two renders are apart.
        await waitFor(() => expect(chip).toHaveAttribute('aria-pressed', 'true'))
        expect(router.state.location.search).toMatch(/^\?folder=/)
        expect(screen.getByText('No meetings in this folder yet.')).toBeInTheDocument()
    })

    it('says why a folder name is refused and keeps the sheet open', async () => {
        renderHome()
        await userEvent.click(await screen.findByRole('button', {name: 'New folder'}))
        await userEvent.type(screen.getByRole('textbox', {name: 'Name'}), 'Acme Corp{Enter}')
        expect(await screen.findByRole('alert')).toBeInTheDocument()
        expect(screen.getByRole('dialog', {name: 'New folder'})).toBeInTheDocument()
    })

    it('renames and deletes the selected folder; its meetings stay', async () => {
        renderHome('/?folder=group-design')
        await userEvent.click(await screen.findByRole('button', {name: 'Folder actions: Design Team'}))
        await userEvent.click(screen.getByRole('menuitem', {name: 'Rename folder…'}))
        const name = screen.getByRole('textbox', {name: 'Name'})
        await userEvent.clear(name)
        await userEvent.type(name, 'Design{Enter}')
        expect(await screen.findByRole('button', {name: 'Design'})).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Folder actions: Design'}))
        await userEvent.click(screen.getByRole('menuitem', {name: 'Delete folder…'}))
        expect(screen.getByRole('dialog', {name: 'Delete “Design”?'})).toHaveTextContent('Its 2 meetings stay in the list, in no folder.')
        await userEvent.click(screen.getByRole('button', {name: 'Delete folder'}))

        await waitFor(() => expect(screen.queryByRole('button', {name: 'Design'})).not.toBeInTheDocument())
        expect(screen.getByRole('button', {name: 'All'})).toHaveAttribute('aria-pressed', 'true')
        expect(rowTitles()).toContain('Onboarding flow critique')
    })

    it('renames a meeting with F2 on its row', async () => {
        renderHome()
        const row = await screen.findByRole('link', {name: /Q4 roadmap planning/})
        row.focus()
        await userEvent.keyboard('{F2}')
        const title = screen.getByRole('textbox', {name: 'Title'})
        expect(title).toHaveValue('Q4 roadmap planning')
        await userEvent.clear(title)
        await userEvent.type(title, 'Q4 roadmap{Enter}')
        expect(await screen.findByRole('link', {name: /^Q4 roadmap \d/})).toBeInTheDocument()
    })

    it('shows an empty state that offers Import when there are no meetings', async () => {
        mockState.meetings.meetings = []
        renderHome()
        const importDialog = renderHook(() => useDialog())
        expect(await screen.findByText('No meetings yet')).toBeInTheDocument()
        expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Import a recording'}))
        expect(importDialog.result.current.open).toBe(true)
    })

    it('offers Import beside Settings once there are meetings', async () => {
        renderHome()
        const importDialog = renderHook(() => useDialog())
        await screen.findByRole('region', {name: 'Today'})
        await userEvent.click(screen.getByRole('button', {name: 'Import a recording'}))
        expect(importDialog.result.current.open).toBe(true)
    })

    it('announces a downloaded update and installs it on request', async () => {
        downloadedOffer()
        renderHome()
        const banner = await screen.findByText('Update ready')
        expect(banner.closest('[role="status"]')).toHaveTextContent('Protocol 0.9.0 is downloaded. Restart when it suits you, or it installs when you quit.')

        await userEvent.click(screen.getByRole('button', {name: 'Release notes'}))
        const notes = screen.getByRole('dialog', {name: 'What’s new in 0.9.0'})
        // The changelog's Markdown is drawn, not shown as written.
        expect(within(notes).getByRole('heading', {name: 'Changed'})).toBeInTheDocument()
        expect(within(notes).getByRole('listitem')).toHaveTextContent('Faster summaries.')
        expect(notes).not.toHaveTextContent('**')
        await userEvent.keyboard('{Escape}')

        await userEvent.click(screen.getByRole('button', {name: 'Restart and update'}))
        await waitFor(() => expect(mockState.updater.activity.state).toBe('installing'))
    })

    it('opens a banner’s slot as it arrives, so the list below slides instead of jumping', async () => {
        await playAnimations()
        downloadedOffer()
        const styles = watchStyles()
        renderHome()
        const banner = (await screen.findByText('Update ready')).closest('[role="status"]') as HTMLElement

        // The slot grows under a clip, then hands its height back to the layout.
        const slot = banner.parentElement as HTMLElement
        await waitFor(() => expect(styles.valuesOf(slot, 'overflow')).toEqual(['hidden', '']), {timeout: 2000})
    })

    it('says what an install waits for while work runs', async () => {
        downloadedOffer()
        mockState.updater = {...mockState.updater, busyReasons: ['summary']}
        renderHome()
        await userEvent.click(await screen.findByRole('button', {name: 'Restart and update'}))
        expect(await screen.findByText(/summary/i, {selector: 'p'})).toBeInTheDocument()
        expect(mockState.updater.activity.state).not.toBe('installing')
    })

    it('shows no update banner while the offer is not downloaded or must be installed by hand', async () => {
        downloadedOffer()
        mockState.updater = {...mockState.updater, offer: {...mockState.updater.offer!, manualOnly: true}}
        renderHome()
        await screen.findByRole('region', {name: 'Today'})
        expect(screen.queryByText('Update ready')).not.toBeInTheDocument()
    })

    it('says the summary model is missing after its first download was cut, and resumes it', async () => {
        mockState.models.builtIn['qwen3.5:4b'] = {type: 'incomplete', file_size: 687_748_972, expected_size: 2_740_937_888}
        renderRoute('/', [{path: '/', element: <HomeWithDownloads/>}])

        expect(await screen.findByText('The summary model isn’t downloaded')).toBeInTheDocument()
        expect(screen.getByText(/stopped downloading at 25%/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Resume download'}))
        await waitFor(() => expect(screen.queryByText('The summary model isn’t downloaded')).not.toBeInTheDocument())
    })

    it('shows no summary model banner while the model is installed or another provider writes summaries', async () => {
        renderHome()
        await screen.findByRole('region', {name: 'Today'})
        expect(screen.queryByText('The summary model isn’t downloaded')).not.toBeInTheDocument()
    })
})
