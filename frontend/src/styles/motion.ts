import type {Transition} from 'motion/react'

/**
 * Motion tokens. CSS reads them through `theme.motion` (milliseconds and
 * `cubic-bezier()` strings); motion/react reads them here, through `tween()`
 * and `springs`. docs/UI_ARCHITECTURE.md, Motion, says what uses which.
 */

/** Durations in milliseconds. */
export const durations = {
    /** Hover, press and focus: feedback that has to feel immediate. */
    fast: 120,
    /** A status line, a fade, a menu: most changes of state. */
    base: 200,
    /** Large surfaces: a sheet, the crossfade of a theme change. */
    slow: 320,
} as const

export type DurationName = keyof typeof durations

type Bezier = readonly [number, number, number, number]

/** Cubic-bezier control points. */
export const easings = {
    /** Moves and fades inside the window: a quick start, a soft stop. */
    standard: [0.2, 0, 0, 1],
    /** Something arriving. */
    enter: [0, 0, 0.2, 1],
    /** Something leaving, which may stop abruptly. */
    exit: [0.4, 0, 1, 1],
} as const satisfies Record<string, Bezier>

export type EasingName = keyof typeof easings

/** Springs for what follows a selection or a gesture. */
export const springs = {
    /**
     * An indicator jumping between options: a segmented control, tabs.
     * Settles in about 250 ms with no visible overshoot.
     */
    snappy: {type: 'spring', stiffness: 520, damping: 34, mass: 0.45},
    /** A larger surface that settles: a sheet, a panel. */
    gentle: {type: 'spring', stiffness: 260, damping: 30, mass: 1},
} as const satisfies Record<string, Transition>

/** A motion/react transition built from the duration and easing tokens. */
export function tween(duration: DurationName, easing: EasingName = 'standard'): Transition {
    return {duration: durations[duration] / 1000, ease: [...easings[easing]]}
}

export const cubicBezier = ([x1, y1, x2, y2]: Bezier) => `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})`

/**
 * CSS movement (a transform on press, a slide) goes inside this media query,
 * so reduced motion keeps only the colour and opacity changes outside it.
 */
export const MOTION_OK = '@media (prefers-reduced-motion: no-preference)'
