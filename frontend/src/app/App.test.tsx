import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {handlers} from '@/mocks/handlers'
import {THEME_STORAGE_KEY} from '@/styles/themeMode'
import packageJson from '../../package.json'
import {App} from './App'

function renderApp() {
    return render(
        <QueryClientProvider client={new QueryClient()}>
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

    it('serves the minibar window its own route', () => {
        window.history.replaceState(null, '', '/minibar')

        renderApp()

        expect(screen.getByText('Minibar placeholder')).toBeInTheDocument()
    })

    it('sends an unknown route home', () => {
        window.history.replaceState(null, '', '/settings')

        renderApp()

        expect(screen.getByRole('radiogroup', {name: 'Theme'})).toBeInTheDocument()
    })
})
