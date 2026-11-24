import {createElement, type ReactElement} from 'react'
import {QueryClientProvider} from '@tanstack/react-query'
import {MemoryRouter} from 'react-router-dom'
import {useToastStore} from '@/components/ui/toastStore'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'

/** Renders recording UI as the shell mounts it: a query client and a router. */
export function renderRecording(ui: ReactElement, {path = '/recording'} = {}) {
    const client = createTestQueryClient()
    const wrap = (next: ReactElement) =>
        createElement(QueryClientProvider, {client}, createElement(MemoryRouter, {initialEntries: [path]}, next))
    const result = renderUi(wrap(ui))
    // The router keeps its place across a rerender, as the app's does.
    return {...result, client, rerender: (next: ReactElement) => result.rerender(wrap(next))}
}

/** The titles of the toasts on screen, newest first. */
export const toastTitles = () => useToastStore.getState().toasts.map((toast) => toast.title)
