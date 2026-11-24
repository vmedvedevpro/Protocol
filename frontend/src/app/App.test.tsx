import {QueryClientProvider} from '@tanstack/react-query'
import {act, render, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {UPDATER_STATUS_EVENT, type UpdaterSnapshot} from '@/api/updater'
import {handlers} from '@/mocks/handlers'
import {emitMockEvent, installMockIpc} from '@/mocks/ipc'
import {mockState} from '@/mocks/state'
import {THEME_STORAGE_KEY} from '@/styles/themeMode'
import {createTestQueryClient} from '@/test/queryClient'
import packageJson from '../../package.json'
import {App} from './App'

function renderApp() {
    return render(
        <QueryClientProvider client={createTestQueryClient()}>
            <App/>
        </QueryClientProvider>,
    )
}

describe('App', () => {
    it('shows the shell with the version from the app plugin', async () => {
        renderApp()

        expect(await screen.findByText(new RegExp(`^${packageJson.version} · `))).toBeInTheDocument()
        expect(await screen.findByText('Updates are off in development builds')).toBeInTheDocument()
    })

    it('shows what the updater is doing, a failed check and the result', async () => {
        renderApp()
        const status = await screen.findByRole('status')
        await within(status).findByText('Updates are off in development builds')
        const installed: UpdaterSnapshot = {...mockState.updater, support: {kind: 'updatable', install: 'nsis'}}

        await emitMockEvent(UPDATER_STATUS_EVENT, {...installed, activity: {state: 'checking', manual: true}})
        expect(await within(status).findByText('Checking for updates…')).toBeInTheDocument()

        const failure = {kind: 'network', action: 'check', message: 'offline', at: 1, background: false} as const
        await emitMockEvent(UPDATER_STATUS_EVENT, {...installed, lastCheckedAt: 1, error: failure})
        expect(await within(status).findByText("Couldn't check for updates")).toBeInTheDocument()

        // An automatic check that failed is news only in Settings.
        await emitMockEvent(UPDATER_STATUS_EVENT, {...installed, lastCheckedAt: 1, error: {...failure, background: true}})
        expect(await within(status).findByText('Up to date')).toBeInTheDocument()
    })

    it('saves the chosen theme and forces it on the native window', async () => {
        const setTheme = vi.spyOn(handlers, 'plugin:window|set_theme')
        renderApp()

        await userEvent.click(screen.getByText('Dark'))

        expect(screen.getByRole('radio', {name: 'Dark'})).toBeChecked()
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
        await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({value: 'dark'})))

        await userEvent.click(screen.getByText('Match system'))

        // null hands the window back to the OS theme.
        await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({value: null})))
    })

    it('follows the OS again when the other window removes the saved theme', async () => {
        const setTheme = vi.spyOn(handlers, 'plugin:window|set_theme')
        renderApp()
        await userEvent.click(screen.getByText('Dark'))

        localStorage.removeItem(THEME_STORAGE_KEY)
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {key: THEME_STORAGE_KEY, oldValue: 'dark', newValue: null}))
        })

        expect(await screen.findByRole('radio', {name: 'Match system', checked: true})).toBeInTheDocument()
        await waitFor(() => expect(setTheme).toHaveBeenLastCalledWith(expect.objectContaining({value: null})))
    })

    it('serves the minibar window its own route, as the minibar window', async () => {
        window.history.replaceState(null, '', '/minibar')
        // setup.ts installed the mock as the main window; minibar.rs labels
        // the window that opens /minibar `minibar`.
        installMockIpc()
        const setTheme = vi.spyOn(handlers, 'plugin:window|set_theme')

        renderApp()

        expect(screen.getByText('Minibar placeholder')).toBeInTheDocument()
        await waitFor(() => expect(setTheme).toHaveBeenCalledWith(expect.objectContaining({label: 'minibar'})))
    })

    it('sends an unknown route home', () => {
        window.history.replaceState(null, '', '/settings')

        renderApp()

        expect(screen.getByRole('radiogroup', {name: 'Theme'})).toBeInTheDocument()
    })
})
