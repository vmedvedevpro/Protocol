import {type ReactNode, useContext} from 'react'
import {AnimatePresence, PresenceContext, useIsPresent, useMotionValue} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {tween} from '@/styles/motion'

// The clip is a block formatting context, so the margins of the content's
// first and last children stay inside it and count in the measured height.
const Clip = styled(m.div)`
    display: flow-root;
`

const closed = {height: 0}
const opened = {height: 'auto'}

/**
 * Clips only while the height moves: once open, a focus ring at the
 * content's edge shows again. A motion value of its own, set from the
 * animation's start and end: motion 14 puts a `transitionEnd` value in its
 * state without drawing it, so `overflow` stayed hidden there.
 */
function Content({children}: { children: ReactNode }) {
    // Open from the first render, the content arrives without an animation.
    const arrivedStill = useContext(PresenceContext)?.initial === false
    const overflow = useMotionValue(arrivedStill ? 'visible' : 'hidden')
    const isPresent = useIsPresent()
    return (
        <Clip
            style={{overflow}}
            initial={closed}
            animate={opened}
            exit={closed}
            transition={tween('base')}
            onAnimationStart={() => overflow.set('hidden')}
            onAnimationComplete={() => isPresent && overflow.set('visible')}
        >
            {children}
        </Clip>
    )
}

interface CollapseProps {
    /** Shows the content; closing removes it once the height has gone. */
    open: boolean
    children: ReactNode
}

/**
 * Content that a disclosure shows and hides, such as "What's included?" or
 * advanced settings. It opens by growing its height from 0 to the content's
 * under a clip, and closes the same way back, so whatever follows slides
 * instead of jumping. The content itself never fades: text that ends an
 * opacity animation is rasterized again and visibly blinks. Under reduced
 * motion the height jumps, as motion does with every positional value.
 */
export function Collapse({open, children}: CollapseProps) {
    return (
        <AnimatePresence initial={false}>
            {open && <Content>{children}</Content>}
        </AnimatePresence>
    )
}
