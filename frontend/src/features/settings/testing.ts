import {createElement, type ReactElement, type ReactNode} from 'react'
import {QueryClientProvider} from '@tanstack/react-query'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {useModelDownloadSync} from '@/api/modelDownloadSync'
import {useSpeechConfigSync} from '@/api/speech'
import {useUpdaterStatusSync} from '@/api/updater'
import {renderUi} from '@/test/renderUi'
import {createTestQueryClient} from '@/test/queryClient'
import {settingsRoutes} from './stories/settingsRoutes'

/** What App mounts for Settings: the updater snapshot, the downloads and the speech config kept current from their events. */
function AppSync({children}: {children: ReactNode}) {
    useUpdaterStatusSync()
    useModelDownloadSync()
    useSpeechConfigSync()
    return children
}

/**
 * Renders `element` (the Settings page, or a part of it) in Settings'
 * routes, opened at `path`, under the app's providers.
 * `router.state.location` says where it went.
 */
export function renderSettings(element: ReactElement, path = '/settings') {
    const router = createMemoryRouter(settingsRoutes(element), {initialEntries: [path]})
    const view = renderUi(
        createElement(
            QueryClientProvider,
            {client: createTestQueryClient()},
            createElement(AppSync, null, createElement(RouterProvider, {router})),
        ),
    )
    return {...view, router}
}
