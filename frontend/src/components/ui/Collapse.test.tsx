import {screen, waitFor} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {renderUi} from '@/test/renderUi'
import {Collapse} from './Collapse'

describe('Collapse', () => {
    it('renders nothing while closed', () => {
        renderUi(<Collapse open={false}><p>Details</p></Collapse>)

        expect(screen.queryByText('Details')).not.toBeInTheDocument()
    })

    it('grows to its content without fading it, and removes it once closed', async () => {
        const {rerender} = renderUi(<Collapse open={false}><p>Details</p></Collapse>)

        rerender(<Collapse open><p>Details</p></Collapse>)
        const clip = screen.getByText('Details').parentElement as HTMLElement
        await waitFor(() => expect(clip.style.height).toBe('auto'))
        // Open, the clip lets a focus ring at the content's edge show.
        expect(clip.style.overflow).toBe('visible')
        expect(clip.style.opacity).toBe('')

        rerender(<Collapse open={false}><p>Details</p></Collapse>)
        await waitFor(() => expect(screen.queryByText('Details')).not.toBeInTheDocument())
    })

    it('shows content that is open from the start without animating it', () => {
        renderUi(<Collapse open><p>Details</p></Collapse>)

        const clip = screen.getByText('Details').parentElement as HTMLElement
        expect(clip.style.height).toBe('auto')
        expect(clip.style.overflow).toBe('visible')
    })
})
