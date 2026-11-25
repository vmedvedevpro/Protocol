import {screen, waitFor} from '@testing-library/react'
import {MotionGlobalConfig} from 'motion/react'
import {afterEach, describe, expect, it} from 'vitest'
import {settleIpc} from '@/test/ipc'
import {renderUi} from '@/test/renderUi'
import {Crossfade, CrossfadeView} from './Crossfade'

function Views({view}: {view: string}) {
    return (
        <Crossfade>
            <CrossfadeView key={view}><button type="button">{view}</button></CrossfadeView>
        </Crossfade>
    )
}

describe('Crossfade', () => {
    afterEach(() => {
        MotionGlobalConfig.skipAnimations = true
    })

    it('shows the new view and drops the old one once it has faded', async () => {
        const {rerender} = renderUi(<Views view="Simple"/>)

        rerender(<Views view="Sections"/>)

        expect(screen.getByRole('button', {name: 'Sections'})).toBeInTheDocument()
        await waitFor(() => expect(screen.queryByRole('button', {name: 'Simple'})).not.toBeInTheDocument())
    })

    it('puts the leaving view out of reach while it fades', async () => {
        // The fade runs here, so the leaving view is still on screen.
        MotionGlobalConfig.skipAnimations = false
        // MotionProvider loads motion's animation features by a dynamic import:
        // loaded first, they are in place one macrotask after the render.
        await import('./motionFeatures')
        const {rerender} = renderUi(<Views view="Simple"/>)
        await settleIpc()

        rerender(<Views view="Sections"/>)

        expect(screen.getByText('Simple').parentElement).toHaveAttribute('inert')
        expect(screen.getByText('Sections').parentElement).not.toHaveAttribute('inert')
    })

    it('covers the leaving view with the arriving one, so the two never show at once', async () => {
        MotionGlobalConfig.skipAnimations = false
        await import('./motionFeatures')
        const {rerender} = renderUi(<Views view="Simple"/>)
        await settleIpc()

        rerender(<Views view="Sections"/>)

        const leaving = getComputedStyle(screen.getByText('Simple').parentElement as HTMLElement)
        const arriving = getComputedStyle(screen.getByText('Sections').parentElement as HTMLElement)
        expect(Number(arriving.zIndex)).toBeGreaterThan(Number(leaving.zIndex))
        expect(arriving.backgroundColor).not.toBe('')
        expect(arriving.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    })

    it('keeps the views\' z-index inside its own stacking context, under any portal', () => {
        // A Sheet or a Menu portals to <body> at z-index auto; a view's
        // z-index 1 on the root stacking context painted over them (#121).
        renderUi(<Views view="Simple"/>)

        const stack = screen.getByText('Simple').parentElement?.parentElement as HTMLElement
        expect(getComputedStyle(stack).isolation).toBe('isolate')
    })
})
