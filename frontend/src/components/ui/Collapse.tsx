import {type ReactNode, useContext, useLayoutEffect, useRef} from 'react'
import {animate, type AnimationPlaybackControls, AnimatePresence, PresenceContext, usePresence, useReducedMotionConfig} from 'motion/react'
import styled from 'styled-components'
import {tween} from '@/styles/motion'
import {clearStyle, closedStyle, type CollapseSpace, collapseSpace, openStyle} from './collapseSpace'

// The clip is a block formatting context, so the margins of the content's
// first and last children stay inside it and count in the measured height.
const Clip = styled.div`
    display: flow-root;
`

const setStyle = (element: HTMLElement, style: Record<string, number>) => {
    for (const [key, value] of Object.entries(style)) element.style.setProperty(key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), `${value}px`)
}

/**
 * Animated imperatively, since the space it takes is measured from the
 * layout (collapseSpace): the gap and the hairline go with the height, and
 * the inline styles are cleared once open, so nothing changes after the
 * animation ends. Clips only while the height moves: once open, a focus
 * ring at the content's edge shows again.
 */
function Content({children}: { children: ReactNode }) {
    // Open from the first render, the content arrives without an animation.
    const arrivedStill = useContext(PresenceContext)?.initial === false
    const clip = useRef<HTMLDivElement>(null)
    const [isPresent, safeToRemove] = usePresence()
    const reduced = useReducedMotionConfig()
    const space = useRef<CollapseSpace | null>(null)
    const running = useRef<AnimationPlaybackControls | null>(null)

    // A layout effect, so the closed state is on before the first paint.
    useLayoutEffect(() => {
        const element = clip.current
        if (!element) return
        if (!space.current) {
            space.current = collapseSpace(element)
            if (isPresent && arrivedStill) return
            setStyle(element, closedStyle(space.current))
        }
        element.style.overflow = 'hidden'
        const transition = reduced ? {duration: 0} : tween('base')
        // An open or close that the next one interrupts is stopped and
        // finishes nothing, so the newer one stays in charge.
        running.current?.stop()
        const animation = isPresent
            ? animate(element, openStyle(space.current, element), transition)
            : animate(element, closedStyle(space.current), transition)
        running.current = animation
        void animation.then(() => {
            if (running.current !== animation) return
            if (isPresent) clearStyle(element)
            else safeToRemove?.()
        })
    }, [isPresent]) // eslint-disable-line react-hooks/exhaustive-deps -- runs once per open and close

    useLayoutEffect(() => () => running.current?.stop(), [])

    return <Clip ref={clip}>{children}</Clip>
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
 * instead of jumping. The gap and hairline beside it come and go with the
 * height, so the slide ends where the layout does. The content itself never
 * fades: text that ends an opacity animation is rasterized again and visibly
 * blinks. Under reduced motion the height jumps.
 */
export function Collapse({open, children}: CollapseProps) {
    return (
        <AnimatePresence initial={false}>
            {open && <Content>{children}</Content>}
        </AnimatePresence>
    )
}
