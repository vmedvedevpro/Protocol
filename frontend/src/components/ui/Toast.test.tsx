import {act, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {settleIpc} from '@/test/ipc'
import {playAnimations, watchStyles} from '@/test/motion'
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

    it('swaps its text in place under a veil, never fading the text itself', async () => {
        await playAnimations()
        renderUi(<span/>)
        await settleIpc()
        let id = ''
        act(() => {
            id = toast.loading('Identifying speakers…')
        })
        await waitFor(() => expect(toastNamed('Identifying speakers…')).toBeDefined())

        const styles = watchStyles()
        act(() => {
            toast.success('Found 3 speakers', {id})
        })
        await waitFor(() => expect(toastNamed('Found 3 speakers')).toBeDefined())

        const content = within(toasts()[0]).getByText('Found 3 speakers').closest('li > div') as HTMLElement
        const veil = content.lastElementChild as HTMLElement
        expect(veil).toHaveAttribute('aria-hidden', 'true')
        expect(getComputedStyle(veil).position).toBe('absolute')
        await waitFor(() => expect(veil.style.opacity).toBe('0'))
        // Text under an opacity below 1 is drawn again when the fade ends, a blink.
        expect(styles.valuesOf(content, 'opacity').filter(Boolean)).toEqual([])
        expect(styles.valuesOf(content, 'transform').length).toBeGreaterThan(1)
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

    it('closes older timed toasts first, and shows a new one even behind persistent ones', async () => {
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

        // Every older toast is persistent: the oldest of them goes, never the new one.
        await waitFor(() => expect(toastNamed('Late')).toBeDefined())
        expect(toasts()).toHaveLength(MAX_TOASTS)
        expect(toastNamed('Your notes were not saved')).toBeUndefined()
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
