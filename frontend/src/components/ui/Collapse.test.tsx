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
        // Open, the stylesheet's layout holds again: nothing changes after the
        // animation, and the clip lets a focus ring at the content's edge show.
        await waitFor(() => expect(clip.getAttribute('style') ?? '').toBe(''))

        rerender(<Collapse open={false}><p>Details</p></Collapse>)
        await waitFor(() => expect(screen.queryByText('Details')).not.toBeInTheDocument())
    })

    it('shows content that is open from the start without animating it', () => {
        renderUi(<Collapse open><p>Details</p></Collapse>)

        const clip = screen.getByText('Details').parentElement as HTMLElement
        expect(clip.getAttribute('style') ?? '').toBe('')
    })

    it('starts closed without the gap and the hairline beside it, before the first paint', () => {
        const {rerender} = renderUi(<Card open={false}/>)

        rerender(<Card open/>)
        const clip = screen.getByText('Details').parentElement as HTMLElement
        expect(clip.style.height).toBe('0px')
        expect(clip.style.marginTop).toBe('-8px')
        expect(clip.style.borderTopWidth).toBe('0px')
    })
})

// A settings card's column: rows 8 px apart, a hairline on every row after the first.
function Card({open}: { open: boolean }) {
    return (
        <div className="card" style={{display: 'flex', flexDirection: 'column', rowGap: 8}}>
            <style>{'.card > * + * { border-top: 1px solid; }'}</style>
            <p>Save audio</p>
            <Collapse open={open}><p>Details</p></Collapse>
        </div>
    )
}
