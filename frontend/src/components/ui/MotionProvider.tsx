import type {ReactNode} from 'react'
import {LazyMotion, MotionConfig} from 'motion/react'

const loadFeatures = () => import('./motionFeatures').then((module) => module.default)

/**
 * Loads motion's DOM animation features once for the tree, after the first
 * render, so components use the small `m` elements; `strict` turns a full
 * `motion` element into an error. Until the features arrive, an `m` element
 * keeps the values it mounted with and catches up when they come. Under
 * reduced motion (the OS setting), transform animations jump to their end
 * while opacity still fades.
 */
export function MotionProvider({children}: { children: ReactNode }) {
    return (
        <LazyMotion features={loadFeatures} strict>
            <MotionConfig reducedMotion="user">{children}</MotionConfig>
        </LazyMotion>
    )
}
