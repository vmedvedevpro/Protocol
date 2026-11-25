import {act} from '@testing-library/react'
import {QueryClientProvider} from '@tanstack/react-query'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {type DialogRequest, openDialog} from '@/lib/dialogs'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'
import {DialogHost} from './DialogHost'

/**
 * Renders the dialogs as the shell mounts them, under a memory router (a
 * test reads where a dialog went from `router.state.location`), and opens
 * `request` when given.
 */
export function renderDialogs(request?: DialogRequest, url = '/') {
    const client = createTestQueryClient()
    const router = createMemoryRouter(
        [{path: '*', element: <><DialogHost/><p>Screen</p></>}],
        {initialEntries: [url]},
    )
    const result = renderUi(
        <QueryClientProvider client={client}>
            <RouterProvider router={router}/>
        </QueryClientProvider>,
    )
    if (request) act(() => openDialog(request))
    return {...result, client, router}
}
