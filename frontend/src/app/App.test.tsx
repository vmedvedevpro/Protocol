import {QueryClientProvider} from '@tanstack/react-query'
import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import type {PendingCrashReport} from '@/api/crashReport'
import {TRAY_NAVIGATE_EVENT, TRAY_START_RECORDING_EVENT} from '@/api/tray'
import {handlers} from '@/mocks/handlers'
import {emitMockEvent, installMockIpc} from '@/mocks/ipc'
import {mockState} from '@/mocks/state'
import {THEME_STORAGE_KEY, useThemeModeStore} from '@/styles/themeMode'
import {createTestQueryClient} from '@/test/queryClient'
import {App} from './App'
import {KEEP_ON_TOP_STORAGE_KEY, useKeepOnTopStore} from './shell/keepOnTop'
import {STARTUP_PATIENCE_MS} from './shell/startup'

// The radio itself is invisible to the pointer; a user clicks its label.
const option = (name: string) => screen.getByRole('radio', {name}).closest('label') as HTMLElement

const heading = (name: string) => screen.findByRole('heading', {level: 1, name})

// listen() registers asynchronously; an event sent before that goes nowhere.
const listenersRegistered = () => new Promise((resolve) => setTimeout(resolve, 0))

function renderApp(path = '/') {
    window.history.replaceState(null, '', path)
    return render(
        <QueryClientProvider client={createTestQueryClient()}>
            <App/>
        </QueryClientProvider>,
    )
}

const report: PendingCrashReport = {
    reportId: '0123456789abcdef',
    detectedAt: '2026-11-23T18:30:00Z',
    crashType: 'panic',
    appVersion: '0.6.0',
}

describe('App startup', () => {
    it('checks setup, then shows the meetings with the window landmarks side by side', async () => {
        renderApp()

        expect(screen.getByText('Checking setup…')).toBeInTheDocument()
        await heading('Meetings')
        const banner = screen.getByRole('banner')
        const main = screen.getByRole('main')
        const footer = screen.getByRole('contentinfo')
        expect(banner.parentElement).toBe(main.parentElement)
        expect(footer.parentElement).toBe(main.parentElement)
        expect(within(footer).getByRole('group', {name: 'Record'})).toBeInTheDocument()
        // The title strip drags the window; its buttons stay clickable.
        expect(banner).toHaveAttribute('data-tauri-drag-region', 'deep')
        expect(within(banner).queryByRole('button', {name: 'Back to meetings'})).not.toBeInTheDocument()
    })

    it('offers Retry when the setup check fails, and goes on once it succeeds', async () => {
        const status = vi.spyOn(handlers, 'get_onboarding_status').mockImplementation(() => {
            throw 'Failed to load onboarding status: store locked'
        })
        renderApp()

        expect(await screen.findByText('Unable to check setup status. Please retry.')).toBeInTheDocument()
        status.mockRestore()
        await userEvent.click(screen.getByRole('button', {name: 'Retry'}))

        await heading('Meetings')
    })

    it('offers Retry when the setup check stalls', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
        try {
            vi.spyOn(handlers, 'get_onboarding_status').mockImplementation(() => new Promise(() => undefined))
            renderApp()
            expect(screen.getByText('Checking setup…')).toBeInTheDocument()

            await act(() => vi.advanceTimersByTimeAsync(STARTUP_PATIENCE_MS))

            expect(screen.getByText('Setup status is taking longer than expected.')).toBeInTheDocument()
            expect(screen.getByRole('button', {name: 'Retry'})).toBeInTheDocument()
        } finally {
            vi.useRealTimers()
        }
    })

    it('shows first launch until it is done, and starts nothing meanwhile', async () => {
        mockState.onboarding = null
        mockState.crashReport = report
        renderApp()
        await heading('Welcome to Protocol')
        await listenersRegistered()

        await emitMockEvent(TRAY_START_RECORDING_EVENT, null)
        await userEvent.keyboard('{Control>}r{/Control}')

        expect(screen.getByRole('heading', {level: 1, name: 'Welcome to Protocol'})).toBeInTheDocument()
        // The crash report waits for first launch too, as in the old app.
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
})

describe('App navigation', () => {
    it('opens the page the tray asks for, without a reload', async () => {
        renderApp()
        await heading('Meetings')
        await listenersRegistered()

        await emitMockEvent(TRAY_NAVIGATE_EVENT, '/settings?section=about')

        await heading('Settings')
        expect(screen.getByText('Opened at the old section “about”.')).toBeInTheDocument()
        // Settings docks no bar, and an empty footer is no landmark.
        expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    })

    it("opens the recording screen from the tray's Start", async () => {
        renderApp()
        await heading('Meetings')
        await listenersRegistered()

        await emitMockEvent(TRAY_START_RECORDING_EVENT, null)

        await heading('Recording')
    })

    it('opens Settings and the recording screen from the keyboard, and goes back to the meetings', async () => {
        renderApp()
        await heading('Meetings')

        await userEvent.keyboard('{Control>}[Comma]{/Control}')
        await heading('Settings')
        await userEvent.click(screen.getByRole('button', {name: 'Back to meetings'}))
        await heading('Meetings')
        // The key, not the letter: Ctrl R on a Russian layout types к.
        await userEvent.keyboard('{Control>}[KeyR]{/Control}')
        await heading('Recording')
    })

    it('moves focus to the new screen after a navigation, and leaves it on the first screen', async () => {
        renderApp()
        await heading('Meetings')
        expect(screen.getByRole('main')).not.toHaveFocus()

        screen.getByRole('button', {name: 'Settings'}).focus()
        await userEvent.keyboard('{Enter}')
        await heading('Settings')
        await waitFor(() => expect(screen.getByRole('main')).toHaveFocus())

        screen.getByRole('button', {name: 'Back to meetings'}).focus()
        await userEvent.keyboard('{Enter}')
        await heading('Meetings')
        await waitFor(() => expect(screen.getByRole('main')).toHaveFocus())
    })

    it('sends an unknown route home', async () => {
        renderApp('/contacts')

        await heading('Meetings')
        expect(window.location.pathname).toBe('/')
    })

    it('serves the minibar window its own route, as the minibar window', async () => {
        window.history.replaceState(null, '', '/minibar')
        // setup.ts installed the mock as the main window; minibar.rs labels
        // the window that opens /minibar `minibar`.
        installMockIpc()
        const setTheme = vi.spyOn(handlers, 'plugin:window|set_theme')

        renderApp('/minibar')

        expect(screen.getByText('Minibar placeholder')).toBeInTheDocument()
        expect(screen.queryByRole('banner')).not.toBeInTheDocument()
        await waitFor(() => expect(setTheme).toHaveBeenCalledWith(expect.objectContaining({label: 'minibar'})))
    })
})

describe('Keep on top', () => {
    it('pins the window above the others and remembers it', async () => {
        const onTop = vi.spyOn(handlers, 'plugin:window|set_always_on_top')
        renderApp()
        await heading('Meetings')
        const pin = screen.getByRole('button', {name: 'Keep on top'})
        expect(pin).toHaveAttribute('aria-pressed', 'false')

        await userEvent.click(pin)

        expect(pin).toHaveAttribute('aria-pressed', 'true')
        await waitFor(() => expect(onTop).toHaveBeenLastCalledWith(expect.objectContaining({value: true})))
        expect(JSON.parse(localStorage.getItem(KEEP_ON_TOP_STORAGE_KEY)!).state).toEqual({onTop: true})
    })

    it('applies the saved pin when the window opens', async () => {
        localStorage.setItem(KEEP_ON_TOP_STORAGE_KEY, JSON.stringify({state: {onTop: true}, version: 0}))
        await useKeepOnTopStore.persist.rehydrate()
        const onTop = vi.spyOn(handlers, 'plugin:window|set_always_on_top')

        renderApp()

        expect(await screen.findByRole('button', {name: 'Keep on top', pressed: true})).toBeInTheDocument()
        await waitFor(() => expect(onTop).toHaveBeenCalledWith(expect.objectContaining({value: true})))
    })
})

describe('Crash report', () => {
    it('saves the ZIP where the user chose and dismisses the report', async () => {
        mockState.crashReport = report
        renderApp()

        const sheet = await screen.findByRole('dialog', {name: 'Protocol encountered a problem'})
        expect(within(sheet).getByText(/internal error during the previous session/)).toBeInTheDocument()
        expect(within(sheet).getByText('0.6.0')).toBeInTheDocument()
        await userEvent.click(within(sheet).getByRole('button', {name: 'Save ZIP'}))

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(mockState.crashReportZips).toEqual(['/home/user/Protocol-crash.zip'])
        expect(mockState.crashReport).toBeNull()
    })

    it('opens a GitHub issue to send the report', async () => {
        mockState.crashReport = report
        renderApp()

        const sheet = await screen.findByRole('dialog')
        await userEvent.click(within(sheet).getByRole('button', {name: 'Send Report'}))

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(mockState.crashReportZips).toHaveLength(1)
        expect(mockState.openedUrls).toEqual([expect.stringMatching(/^https:\/\/github\.com\/vmedvedevpro\/Protocol\/issues\/new\?/)])
    })

    it('stays open when the save dialog is cancelled, and says when saving failed', async () => {
        mockState.crashReport = report
        mockState.saveDialogPath = null
        renderApp()
        const sheet = await screen.findByRole('dialog')

        await userEvent.click(within(sheet).getByRole('button', {name: 'Save ZIP'}))
        await waitFor(() => expect(within(sheet).getByRole('button', {name: 'Save ZIP'})).toBeEnabled())
        expect(mockState.crashReportZips).toEqual([])

        mockState.saveDialogPath = '/home/user/report'
        vi.spyOn(handlers, 'create_crash_report_zip').mockImplementation(() => {
            throw 'Failed to create crash report ZIP: disk full'
        })
        await userEvent.click(within(sheet).getByRole('button', {name: 'Save ZIP'}))

        expect(await within(sheet).findByRole('alert')).toHaveTextContent("Couldn't save the crash report.")
        expect(mockState.crashReport).toEqual(report)
    })

    it('leaves the title strip working while the sheet is open', async () => {
        mockState.crashReport = report
        renderApp()
        await screen.findByRole('dialog')

        // The modal sheet hides the window from assistive technology meanwhile.
        const pin = screen.getByRole('button', {name: 'Keep on top', hidden: true})
        await userEvent.click(pin)

        expect(pin).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('keeps the report for the next launch when closed without a choice', async () => {
        mockState.crashReport = report
        renderApp()
        await screen.findByRole('dialog')

        await userEvent.keyboard('{Escape}')

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(mockState.crashReport).toEqual(report)
    })
})

describe('Theme', () => {
    it('saves the chosen theme and forces it on the native window', async () => {
        const setTheme = vi.spyOn(handlers, 'plugin:window|set_theme')
        renderApp('/settings')
        await heading('Settings')

        await userEvent.click(option('Dark'))

        expect(screen.getByRole('radio', {name: 'Dark'})).toBeChecked()
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
        await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({value: 'dark'})))

        await userEvent.click(option('Match system'))

        // null hands the window back to the OS theme.
        await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({value: null})))
    })

    it('follows the OS again when the other window removes the saved theme', async () => {
        const setTheme = vi.spyOn(handlers, 'plugin:window|set_theme')
        renderApp('/settings')
        await heading('Settings')
        await userEvent.click(option('Dark'))

        localStorage.removeItem(THEME_STORAGE_KEY)
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {key: THEME_STORAGE_KEY, oldValue: 'dark', newValue: null}))
        })

        expect(await screen.findByRole('radio', {name: 'Match system', checked: true})).toBeInTheDocument()
        await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({value: null})))
    })

    it('crossfades a theme change made in the other window', async () => {
        renderApp('/settings')
        await heading('Settings')
        await userEvent.click(option('Dark'))
        const modes: string[] = []
        Object.assign(document, {
            startViewTransition: (update: () => void) => {
                update()
                modes.push(useThemeModeStore.getState().mode)
            },
        })

        localStorage.setItem(THEME_STORAGE_KEY, 'light')
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {key: THEME_STORAGE_KEY, oldValue: 'dark', newValue: 'light'}))
        })

        // The storage is synchronous: the mode changed inside the update.
        expect(modes).toEqual(['light'])
        expect(screen.getByRole('radio', {name: 'Light'})).toBeChecked()
    })
})
