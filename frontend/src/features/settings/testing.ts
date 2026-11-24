import {createElement, type ReactElement, type ReactNode} from 'react'
import {QueryClientProvider} from '@tanstack/react-query'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {useUpdaterStatusSync} from '@/api/updater'
import {renderUi} from '@/test/renderUi'
import {createTestQueryClient} from '@/test/queryClient'
import {SettingsSubpage} from './pages/SettingsSubpage'

/** What App mounts for Settings: the updater snapshot kept current from its event. */
export function AppSync({children}: {children: ReactNode}) {
    useUpdaterStatusSync()
    return children
}

/**
 * Renders `element` (the Settings page, or a part of it) at `/settings`,
 * opened at `path`, under the app's providers, with the subpages and a
 * Meetings stand-in to navigate to. `router.state.location` says where it went.
 */
export function renderSettings(element: ReactElement, path = '/settings') {
    const router = createMemoryRouter(
        [
            {path: '/', element: createElement('h1', null, 'Meetings')},
            {path: '/settings', element},
            {path: '/settings/:page', element: createElement(SettingsSubpage)},
        ],
        {initialEntries: [path]},
    )
    const view = renderUi(
        createElement(
            QueryClientProvider,
            {client: createTestQueryClient()},
            createElement(AppSync, null, createElement(RouterProvider, {router})),
        ),
    )
    return {...view, router}
}
