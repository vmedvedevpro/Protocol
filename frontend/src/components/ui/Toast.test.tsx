import {act, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {renderUi} from '@/test/renderUi'
import {MAX_TOASTS, toast} from './toastStore'

// The toasts live in Radix's list under the "Notifications" region; Radix
// also copies a new toast's text into a hidden announcement for a second.
const toasts = () => within(screen.getByRole('region', {name: /Notifications/})).queryAllByRole('listitem')
const toastNamed = (title: string) => toasts().find((item) => within(item).queryByText(title))

describe('Toast', () => {
    it('shows a title and description under the Notifications region, then closes after its duration', async () => {
        renderUi(<span/>)

        act(() => {
            toast.success('Meeting recovered', {description: 'Transcript and audio recovered.', duration: 50})
        })

        const item = await waitFor(() => {
            const shown = toastNamed('Meeting recovered')
            expect(shown).toBeDefined()
            return shown!
        })
        expect(item).toHaveTextContent('Transcript and audio recovered.')
        await waitFor(() => expect(toasts()).toHaveLength(0))
    })

    it('runs its action and closes', async () => {
        const open = vi.fn()
        renderUi(<span/>)

        act(() => {
            toast.success('Meeting recovered', {action: {label: 'Open', onClick: open}, duration: Infinity})
        })
        await userEvent.click(await screen.findByRole('button', {name: 'Open'}))

        expect(open).toHaveBeenCalledOnce()
        await waitFor(() => expect(toasts()).toHaveLength(0))
    })

    it('closes from its close button and from Escape', async () => {
        renderUi(<span/>)

        act(() => {
            toast.info('Downloads continue in the background', {duration: Infinity})
        })
        await userEvent.click(await screen.findByRole('button', {name: 'Close'}))
        await waitFor(() => expect(toasts()).toHaveLength(0))

        act(() => {
            toast.warning('Computer audio is not reaching Protocol', {duration: Infinity})
        })
        await waitFor(() => expect(toasts()).toHaveLength(1))
        act(() => toasts()[0].focus())
        await userEvent.keyboard('{Escape}')
        await waitFor(() => expect(toasts()).toHaveLength(0))
    })

    it('replaces a toast shown again with the same id where it stands, and announces the outcome', async () => {
        renderUi(<span/>)

        let id = ''
        act(() => {
            id = toast.loading('Identifying speakers…')
        })
        await waitFor(() => expect(toasts()).toHaveLength(1))

        act(() => {
            toast.success('Found 3 speakers', {id, description: '42 lines labelled.'})
        })

        await waitFor(() => expect(toastNamed('Found 3 speakers')).toBeDefined())
        expect(toasts()).toHaveLength(1)
        // Announced once, then gone, so no live region lingers in the window.
        expect(await screen.findByText('Found 3 speakers. 42 lines labelled.', {selector: '[role="status"]'})).toBeInTheDocument()
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument(), {timeout: 2000})
    })

    it(`keeps at most ${MAX_TOASTS}, closing the oldest`, async () => {
        renderUi(<span/>)

        act(() => {
            for (let n = 1; n <= MAX_TOASTS + 1; n++) toast(`Toast ${n}`, {duration: Infinity})
        })

        await waitFor(() => expect(toasts()).toHaveLength(MAX_TOASTS))
        expect(toastNamed('Toast 1')).toBeUndefined()
        // Newest on top.
        expect(toasts()[0]).toHaveTextContent(`Toast ${MAX_TOASTS + 1}`)
    })

    it('closes timed toasts first and never a persistent one for a timed one', async () => {
        renderUi(<span/>)

        act(() => {
            toast.warning('Your notes were not saved', {duration: Infinity, action: {label: 'Copy notes', onClick: () => {}}})
            for (let n = 1; n <= MAX_TOASTS; n++) toast(`Toast ${n}`, {duration: 30_000})
        })

        await waitFor(() => expect(toasts()).toHaveLength(MAX_TOASTS))
        expect(toastNamed('Your notes were not saved')).toBeDefined()
        expect(toastNamed('Toast 1')).toBeUndefined()

        act(() => {
            for (let n = 1; n < MAX_TOASTS; n++) toast(`Pinned ${n}`, {duration: Infinity})
            toast('Late', {duration: 30_000})
        })

        await waitFor(() => expect(toastNamed('Late')).toBeUndefined())
        expect(toasts()).toHaveLength(MAX_TOASTS)
        expect(toastNamed('Your notes were not saved')).toBeDefined()
    })

    it('dismisses one toast by id, or all of them', async () => {
        renderUi(<span/>)

        let first = ''
        act(() => {
            first = toast('First', {duration: Infinity})
            toast('Second', {duration: Infinity})
        })
        await waitFor(() => expect(toasts()).toHaveLength(2))

        act(() => toast.dismiss(first))
        await waitFor(() => expect(toasts()).toHaveLength(1))
        expect(toastNamed('Second')).toBeDefined()

        act(() => toast.dismiss())
        await waitFor(() => expect(toasts()).toHaveLength(0))
    })
})
