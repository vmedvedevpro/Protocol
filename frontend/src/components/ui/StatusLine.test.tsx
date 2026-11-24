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
        const text = screen.getByText('Downloading…')

        rerender(<StatusLine status={{key: 'downloading', text: 'Downloading…', value: '43%'}}/>)
        expect(screen.getByText('Downloading…')).toBe(text)
        expect(screen.getByText('43%')).toBeInTheDocument()

        rerender(<StatusLine status={{key: 'ready', text: 'Update 0.7.0 is ready'}}/>)
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Update 0.7.0 is ready'))
        expect(screen.queryByText('43%')).not.toBeInTheDocument()
    })
})
