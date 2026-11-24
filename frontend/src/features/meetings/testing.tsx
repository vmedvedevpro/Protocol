import type {ReactElement} from 'react'
import {QueryClientProvider} from '@tanstack/react-query'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'

/**
 * Renders a meetings screen at `url` under a memory router (Home at `/`,
 * the meeting at `/meetings/:meetingId`, a stub for every other path) and a
 * fresh query client, on the mock IPC.
 */
export function renderRoute(url: string, routes: { path: string, element: ReactElement }[]) {
    const client = createTestQueryClient()
    const router = createMemoryRouter([...routes, {path: '*', element: <p>Elsewhere</p>}], {initialEntries: [url]})
    const result = renderUi(
        <QueryClientProvider client={client}>
            <RouterProvider router={router}/>
        </QueryClientProvider>,
    )
    return {...result, client, router}
}
