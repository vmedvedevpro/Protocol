/**
 * What the ring draws in each mode, frame by frame. No WebGL and no DOM: the
 * frame loop (ringLoop.ts) feeds it the time and the level it heard.
 */

/**
 * - `rec`: recording; the edge follows the level.
 * - `test`: the mic test; livelier, so a quiet voice still visibly moves it.
 * - `idle`: ready; greyed, slow, breathing on its own.
 * - `paused`: flat and grey.
 * - `still`: the logo's frame, drawn once.
 */
export type RingMode = 'rec' | 'test' | 'idle' | 'paused' | 'still'

export interface RingState {
    /** The shader's clock in seconds; each mode runs it at its own speed. */
    time: number
    /** The drawn level, 0 to 1, easing toward what the mode follows. */
    level: number
    /** 0 in colour, 1 fully grey. */
    mono: number
}

interface ModeMotion {
    /** How fast the shader's clock runs: the wobble and the walking highlight. */
    speed: number
    /** How grey the ring is, 0 to 1. */
    mono: number
    /** The level the edge eases toward, from the level heard and the time in seconds. */
    follow: (heard: number, seconds: number) => number
}

/**
 * The logo's frame: at time 5.08 the highlight sits at the top left, and level
 * 0.18 keeps the edge calm but alive. `still` draws it, and so does every mode
 * under reduced motion, in that mode's grey.
 */
export const STILL_FRAME = {time: 5.08, level: 0.18}

/** The design's Ring, mode by mode. */
export const RING_MODES: Record<RingMode, ModeMotion> = {
    rec: {speed: 1, mono: 0, follow: (heard) => heard},
    test: {speed: 1, mono: 0, follow: (heard) => Math.min(1, heard * 1.25)},
    // A faint breath of its own; the ring does not listen while it waits.
    idle: {speed: 0.45, mono: 0.55, follow: (_heard, seconds) => 0.04 + 0.03 * Math.sin(seconds * 0.8)},
    // The clock keeps creeping, so the highlight still moves and the ring does
    // not look frozen.
    paused: {speed: 0.15, mono: 1, follow: () => 0},
    still: {speed: 0, mono: 0, follow: () => STILL_FRAME.level},
}

// Per-frame easing at 60 fps from the design: the level closes 12 % of its gap
// each frame (95 % of the way in about 0.4 s), the grey 8 % (0.6 s). Raised to
// the frames elapsed, so the speed does not depend on the frame rate.
const LEVEL_EASE = 0.12
const MONO_EASE = 0.08

const eased = (from: number, to: number, rate: number, dt: number) =>
    from + (to - from) * (1 - (1 - rate) ** (dt * 60))

/** Where the ring starts: settled in its mode, so it does not fade in on mount. */
export function restingRing(mode: RingMode): RingState {
    return {time: STILL_FRAME.time, level: mode === 'idle' ? 0.04 : 0, mono: RING_MODES[mode].mono}
}

/** The one frame a mode shows when the ring does not move. */
export function stillRing(mode: RingMode): RingState {
    const level = mode === 'rec' || mode === 'test' || mode === 'still' ? STILL_FRAME.level : restingRing(mode).level
    return {time: STILL_FRAME.time, level, mono: RING_MODES[mode].mono}
}

/**
 * The next frame, `dt` seconds after `state`. `heard` is the latest level
 * (0 to 1); `seconds` is the wall clock, for the idle breath.
 */
export function advanceRing(state: RingState, mode: RingMode, heard: number, seconds: number, dt: number): RingState {
    const motion = RING_MODES[mode]
    return {
        time: state.time + dt * motion.speed,
        level: eased(state.level, motion.follow(heard, seconds), LEVEL_EASE, dt),
        mono: eased(state.mono, motion.mono, MONO_EASE, dt),
    }
}
