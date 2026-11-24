import type {ReactNode} from 'react'
import {LazyMotion, MotionConfig, type MotionConfigProps} from 'motion/react'

interface MotionProviderProps {
    children: ReactNode
    /** `user` follows the OS setting; Storybook passes `always` to preview it. */
    reducedMotion?: MotionConfigProps['reducedMotion']
}

const loadFeatures = () => import('./motionFeatures').then((module) => module.default)

/**
 * Loads motion's DOM animation features once for the tree, after the first
 * render, so components use the small `m` elements; `strict` turns a full
 * `motion` element into an error. Until the features arrive, an `m` element
 * shows its `animate` values without animating. Under reduced motion,
 * transform animations jump to their end while opacity still fades.
 */
export function MotionProvider({children, reducedMotion = 'user'}: MotionProviderProps) {
    return (
        <LazyMotion features={loadFeatures} strict>
            <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>
        </LazyMotion>
    )
}
