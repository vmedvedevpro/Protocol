import {QueryClientProvider} from '@tanstack/react-query'
import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import type {PendingCrashReport} from '@/api/crashReport'
import {TRAY_NAVIGATE_EVENT, TRAY_START_RECORDING_EVENT} from '@/api/tray'
import {handlers} from '@/mocks/handlers'
import {emitMockEvent, installMockIpc} from '@/mocks/ipc'
import {completedOnboarding} from '@/mocks/onboarding'
import {mockState} from '@/mocks/state'
import {THEME_STORAGE_KEY, useThemeModeStore} from '@/styles/themeMode'
import {createTestQueryClient} from '@/test/queryClient'
import {App} from './App'
import {KEEP_ON_TOP_STORAGE_KEY, useKeepOnTopStore} from './shell/keepOnTop'
import {STARTUP_PATIENCE_MS} from './shell/startup'

// A StatusLine says its text twice: the live region is the copy that counts.
const LIVE = {selector: '[role="status"]'}

// The radio itself is invisible to the pointer; a user clicks its label.
const option = (name: string) => screen.getByRole('radio', {name}).closest('label') as HTMLElement

const heading = (name: string | RegExp) => screen.findByRole('heading', {level: 1, name})

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

        expect(screen.getByText('Checking setup…', LIVE)).toBeInTheDocument()
        await heading('Meetings')
        const banner = screen.getByRole('banner')
        const main = screen.getByRole('main')
        const footer = screen.getByRole('contentinfo')
        expect(banner.parentElement).toBe(main.parentElement)
        expect(footer.parentElement).toBe(main.parentElement)
        expect(within(footer).getByRole('group', {name: 'Record'})).toBeInTheDocument()
        // Tests run as Linux (jsdom's user agent), where the desktop's own
        // title bar moves the window, not the app's row (TitleBar).
        expect(banner).not.toHaveAttribute('data-tauri-drag-region')
        expect(within(banner).queryByRole('button', {name: 'Back to meetings'})).not.toBeInTheDocument()
    })

    it('offers Retry when the setup check fails, and goes on once it succeeds', async () => {
        const status = vi.spyOn(handlers, 'get_onboarding_status').mockImplementation(() => {
            throw 'Failed to load onboarding status: store locked'
        })
        renderApp()

        expect(await screen.findByText('Unable to check setup status. Please retry.', LIVE)).toBeInTheDocument()
        status.mockRestore()
        await userEvent.click(screen.getByRole('button', {name: 'Retry'}))

        await heading('Meetings')
    })

    it('offers Retry when the setup check stalls', async () => {
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
        try {
            vi.spyOn(handlers, 'get_onboarding_status').mockImplementation(() => new Promise(() => undefined))
            renderApp()
            expect(screen.getByText('Checking setup…', LIVE)).toBeInTheDocument()

            await act(() => vi.advanceTimersByTimeAsync(STARTUP_PATIENCE_MS))

            expect(screen.getByText('Setup status is taking longer than expected.', LIVE)).toBeInTheDocument()
            expect(screen.getByRole('button', {name: 'Retry'})).toBeInTheDocument()
        } finally {
            vi.useRealTimers()
        }
    })

    it('offers Retry when the database cannot be set up, and lets first launch in only once it is', async () => {
        mockState.database.exists = false
        mockState.onboarding = null
        const fresh = vi.spyOn(handlers, 'initialize_fresh_database').mockImplementation(() => {
            throw 'Failed to initialize database: migration 20251110000001 was previously applied but is missing'
        })
        renderApp()

        expect(await screen.findByText('Unable to set up the meetings database. Please retry.', LIVE)).toBeInTheDocument()
        // The reason is native's, so a database that does not open says why.
        expect(screen.getByText(/migration 20251110000001 was previously applied but is missing/)).toBeInTheDocument()
        // Native still holds no database: Retry fails again rather than opening the app.
        await userEvent.click(screen.getByRole('button', {name: 'Retry'}))
        await waitFor(() => expect(fresh).toHaveBeenCalledTimes(2))
        expect(await screen.findByText('Unable to set up the meetings database. Please retry.', LIVE)).toBeInTheDocument()

        fresh.mockRestore()
        await userEvent.click(screen.getByRole('button', {name: 'Retry'}))

        await heading('Welcome to Protocol')
        expect(mockState.database.setUps).toEqual(['fresh'])
    })

    it('lets the app in once first launch is done', async () => {
        mockState.onboarding = {...completedOnboarding(), completed: false, current_step: 2}
        renderApp()
        await heading('Get ready for the first meeting')

        await userEvent.click(screen.getByRole('button', {name: 'Done'}))

        await heading('Meetings')
        expect(mockState.onboarding?.completed).toBe(true)
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
        // The old About is General › Updates now.
        expect(await screen.findByRole('tab', {name: 'General', selected: true})).toBeInTheDocument()
        expect(screen.getByRole('region', {name: 'Updates'})).toBeInTheDocument()
        // Settings docks no bar, and an empty footer is no landmark.
        expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    })

    it("records from the tray's Start, on the recording screen", async () => {
        renderApp()
        await heading('Meetings')
        await listenersRegistered()

        await emitMockEvent(TRAY_START_RECORDING_EVENT, null)

        await heading(/^Meeting, /)
        expect(within(screen.getByRole('contentinfo')).getByRole('group', {name: 'Recording'})).toBeInTheDocument()
        expect(mockState.live.recording).not.toBeNull()
    })

    it('opens Settings from the keyboard, goes back, and starts and stops a recording with Ctrl R', async () => {
        renderApp()
        await heading('Meetings')

        await userEvent.keyboard('{Control>}[Comma]{/Control}')
        await heading('Settings')
        await userEvent.click(screen.getByRole('button', {name: 'Back to meetings'}))
        await heading('Meetings')
        // The key, not the letter: Ctrl R on a Russian layout types к.
        await userEvent.keyboard('{Control>}[KeyR]{/Control}')
        await heading(/^Meeting, /)

        // A take this short is discarded.
        await userEvent.keyboard('{Control>}[KeyR]{/Control}')
        await waitFor(() => expect(mockState.live.saveAnswers).toEqual([{stopId: 1, outcome: 'discarded'}]))
    })

    it("names the window after the screen, for the desktop's title bar on Linux", async () => {
        const setTitle = vi.spyOn(handlers, 'plugin:window|set_title')
        renderApp()
        await heading('Meetings')
        await waitFor(() => expect(setTitle).toHaveBeenLastCalledWith(expect.objectContaining({value: 'Protocol'})))

        await userEvent.keyboard('{Control>}[Comma]{/Control}')
        await heading('Settings')
        await waitFor(() => expect(setTitle).toHaveBeenLastCalledWith(expect.objectContaining({value: 'Settings — Protocol'})))
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
        const setTheme = vi.spyOn(handlers, 'linux_set_window_theme')

        renderApp('/minibar')

        expect(await screen.findByRole('group', {name: 'Recording controls'})).toBeInTheDocument()
        expect(screen.queryByRole('banner')).not.toBeInTheDocument()
        // Its theme provider hands the mode to native code too.
        await waitFor(() => expect(setTheme).toHaveBeenCalledWith(expect.objectContaining({theme: null})))
    })
})

describe('Keep on top', () => {
    // Tests run as Linux, where native code keeps the window on top the way
    // the session allows (src/api/window.ts).
    it('pins the window above the others and remembers it', async () => {
        const onTop = vi.spyOn(handlers, 'linux_set_keep_on_top')
        renderApp()
        await heading('Meetings')
        const pin = await screen.findByRole('button', {name: 'Keep on top'})
        expect(pin).toHaveAttribute('aria-pressed', 'false')

        await userEvent.click(pin)

        expect(pin).toHaveAttribute('aria-pressed', 'true')
        await waitFor(() => expect(onTop).toHaveBeenLastCalledWith(expect.objectContaining({onTop: true})))
        expect(JSON.parse(localStorage.getItem(KEEP_ON_TOP_STORAGE_KEY)!).state).toEqual({onTop: true})
    })

    it('applies the saved pin when the window opens', async () => {
        localStorage.setItem(KEEP_ON_TOP_STORAGE_KEY, JSON.stringify({state: {onTop: true}, version: 0}))
        await useKeepOnTopStore.persist.rehydrate()
        const onTop = vi.spyOn(handlers, 'linux_set_keep_on_top')

        renderApp()

        expect(await screen.findByRole('button', {name: 'Keep on top', pressed: true})).toBeInTheDocument()
        await waitFor(() => expect(onTop).toHaveBeenCalledWith(expect.objectContaining({onTop: true})))
    })

    it('says where the pin would be that the session cannot keep a window on top', async () => {
        // GNOME or wlroots on Wayland (keep_above.rs).
        vi.spyOn(handlers, 'linux_keep_on_top_available').mockReturnValue(false)
        const onTop = vi.spyOn(handlers, 'linux_set_keep_on_top')
        renderApp()
        await heading('Meetings')

        expect(await screen.findByText("Keep on top isn't available in this session")).toBeInTheDocument()
        expect(screen.queryByRole('button', {name: 'Keep on top'})).not.toBeInTheDocument()
        expect(onTop).not.toHaveBeenCalled()
    })

    it('sets the pin back and says why when native code cannot keep the window on top', async () => {
        vi.spyOn(handlers, 'linux_set_keep_on_top').mockImplementation(({onTop}) => {
            if (onTop) throw 'KWin refused the script (id -1); KWin scripting may be disabled'
            return null
        })
        renderApp()
        await heading('Meetings')

        await userEvent.click(await screen.findByRole('button', {name: 'Keep on top'}))

        expect(await screen.findByText("Couldn't keep the window on top")).toBeInTheDocument()
        expect(screen.getByText('KWin refused the script (id -1); KWin scripting may be disabled')).toBeInTheDocument()
        await waitFor(() => expect(screen.getByRole('button', {name: 'Keep on top'})).toHaveAttribute('aria-pressed', 'false'))
        expect(JSON.parse(localStorage.getItem(KEEP_ON_TOP_STORAGE_KEY)!).state).toEqual({onTop: false})
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
        const pin = await screen.findByRole('button', {name: 'Keep on top', hidden: true})
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
    // Tests run as Linux (jsdom's user agent), where native code takes the
    // mode instead of Tauri's setTheme (src/api/window.ts).
    it('saves the chosen theme and forces it on the native window', async () => {
        const setTheme = vi.spyOn(handlers, 'linux_set_window_theme')
        const tauriSetTheme = vi.spyOn(handlers, 'plugin:window|set_theme')
        renderApp('/settings')
        await heading('Settings')

        await userEvent.click(option('Dark'))

        expect(screen.getByRole('radio', {name: 'Dark'})).toBeChecked()
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
        await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({theme: 'dark'})))

        await userEvent.click(option('Match system'))

        // null follows the desktop's colour scheme again; tao's setTheme(null)
        // would force light on Linux.
        await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({theme: null})))
        expect(tauriSetTheme).not.toHaveBeenCalled()
    })

    it('follows the OS again when the other window removes the saved theme', async () => {
        const setTheme = vi.spyOn(handlers, 'linux_set_window_theme')
        renderApp('/settings')
        await heading('Settings')
        await userEvent.click(option('Dark'))

        localStorage.removeItem(THEME_STORAGE_KEY)
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {key: THEME_STORAGE_KEY, oldValue: 'dark', newValue: null}))
        })

        expect(await screen.findByRole('radio', {name: 'Match system', checked: true})).toBeInTheDocument()
        await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({theme: null})))
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
