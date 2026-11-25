import {act, renderHook, screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {QueryClientProvider} from '@tanstack/react-query'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {describe, expect, it} from 'vitest'
import {useDialog} from '@/lib/dialogs'
import {openSearch} from '@/lib/searchLauncher'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'
import {GlobalSearch} from './GlobalSearch'

describe('GlobalSearch', () => {
    it('imports a recording from the actions', async () => {
        const router = createMemoryRouter([{path: '*', element: <GlobalSearch/>}], {initialEntries: ['/']})
        renderUi(<QueryClientProvider client={createTestQueryClient()}><RouterProvider router={router}/></QueryClientProvider>)
        const dialog = renderHook(() => useDialog())

        act(() => openSearch())
        const search = await screen.findByRole('dialog', {name: 'Search and commands'})
        await userEvent.click(within(search).getByRole('option', {name: /Import a recording/}))

        expect(dialog.result.current).toMatchObject({open: true, request: {kind: 'import'}})
    })
})
