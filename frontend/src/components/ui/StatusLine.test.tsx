import {screen, waitFor} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {renderUi} from '@/test/renderUi'
import {StatusLine} from './StatusLine'

describe('StatusLine', () => {
    it('keeps a changing value outside the live region', () => {
        renderUi(<StatusLine status={{key: 'downloading', text: 'Downloading 0.7.0…', value: '42%'}}/>)

        const live = screen.getByRole('status')
        expect(live).toHaveTextContent('Downloading 0.7.0…')
        expect(live).not.toHaveTextContent('42%')
        expect(screen.getByText('42%')).toBeInTheDocument()
    })

    it('turns a spinner before a busy status, outside what screen readers hear', () => {
        const {container} = renderUi(<StatusLine status={{key: 'checking', text: 'Checking for updates…', busy: true}}/>)

        expect(screen.getByRole('status')).toHaveTextContent('Checking for updates…')
        expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    })

    it('updates a value in place and swaps the line when the meaning changes', async () => {
        const {rerender} = renderUi(<StatusLine status={{key: 'downloading', text: 'Downloading…', value: '42%'}}/>)
        const live = screen.getByRole('status')
        const value = screen.getByText('42%')

        rerender(<StatusLine status={{key: 'downloading', text: 'Downloading…', value: '43%'}}/>)
        expect(screen.getByText('43%')).toBe(value)

        rerender(<StatusLine status={{key: 'ready', text: 'Update 0.7.0 is ready'}}/>)
        // The live region stays mounted, so the new meaning is announced.
        expect(screen.getByRole('status')).toBe(live)
        expect(live).toHaveTextContent('Update 0.7.0 is ready')
        await waitFor(() => expect(screen.queryByText('43%')).not.toBeInTheDocument())
    })

    it('brings a value in with its own text, as one unit that leaves and arrives', async () => {
        const {container, rerender} = renderUi(<StatusLine status={{key: 'checking', text: 'Checking…', busy: true}}/>)

        rerender(<StatusLine status={{key: 'up-to-date', text: 'Up to date, checked', value: 'just now'}}/>)
        const value = await screen.findByText('just now')
        // The element that rises and is veiled holds both, so a new value
        // never stands beside a leaving text and jumps when the text swaps.
        const text = screen.getByText('Up to date, checked', {ignore: '[role="status"], script, style'})
        expect(text.parentElement).toContainElement(value)
        expect(container).not.toHaveTextContent('Checking…')
    })
})
