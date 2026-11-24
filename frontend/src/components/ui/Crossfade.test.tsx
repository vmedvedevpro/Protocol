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
})
