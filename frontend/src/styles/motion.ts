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
    /** A status line, a fade, a menu, the theme crossfade: most changes of state. */
    base: 200,
    /** Large surfaces: a sheet, a panel. */
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

/**
 * A spinner, the sign of a wait of unknown length (components/ui/Spinner):
 * one `turn` in milliseconds, at a constant speed. One that stands in for
 * content which usually arrives at once, such as a lazy chunk, shows only
 * after `delay` milliseconds, so a fast load does not flash it.
 */
export const spinner = {turn: 900, delay: 400} as const

/**
 * The scale a menu, select list or tooltip grows from toward its anchor, and
 * the one a pressed button shrinks to: small enough to read as movement,
 * not as a zoom.
 */
export const SCALE_FROM = 0.96

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
