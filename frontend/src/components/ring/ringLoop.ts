import type {RingPalette} from '@/styles/theme'
import {createRingRenderer, type RingRenderer} from './ringGl'
import {advanceRing, restingRing, type RingMode, stillRing} from './ringMotion'

export interface RingInputs {
    mode: RingMode
    /** Width and height in CSS pixels. */
    size: number
    palette: RingPalette
}

export interface RingLoop {
    /** New props: a mode change eases over the next frames; a ring held still draws again. */
    update(inputs: RingInputs): void
    /** The latest level heard, 0 to 1; read on the next frame. */
    hear(level: number): void
    stop(): void
}

// The glow is soft, so a canvas past 2 device pixels per CSS pixel looks the
// same and only multiplies the pixels the shader runs for.
const MAX_PIXEL_RATIO = 2
// A frame after a long gap (the loop was off) moves the clock by at most this,
// as in the design.
const MAX_STEP_S = 0.05

/**
 * Runs one ring's requestAnimationFrame loop on `canvas`, or returns null when
 * there is no WebGL. The loop runs only while the ring can move and be seen:
 * it stops while the canvas is off screen, the document is hidden or the user
 * asked for reduced motion. Under reduced motion it draws one frame, again
 * whenever an input changes. `onWebgl` reports a lost and a restored
 * context, so the ring can show its static form meanwhile.
 */
export function startRingLoop(
    canvas: HTMLCanvasElement,
    initial: RingInputs,
    onWebgl: (available: boolean) => void,
): RingLoop | null {
    let renderer: RingRenderer | null = createRingRenderer(canvas)
    if (!renderer) return null
    renderer.setPalette(initial.palette)

    let inputs = initial
    let state = restingRing(inputs.mode)
    let heard = 0
    let frame = 0
    let last = 0
    let onScreen = true
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null

    const pixels = () => Math.round(inputs.size * Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO))
    const held = () => reducedMotion?.matches === true

    const tick = (now: number) => {
        const dt = Math.min(MAX_STEP_S, Math.max(0, (now - last) / 1000))
        last = now
        state = advanceRing(state, inputs.mode, heard, now / 1000, dt)
        renderer?.draw(state, pixels())
        frame = requestAnimationFrame(tick)
    }

    // Every change that can start or stop the loop comes through here.
    const sync = () => {
        if (renderer && onScreen && !document.hidden && !held()) {
            if (!frame) {
                last = performance.now()
                frame = requestAnimationFrame(tick)
            }
            return
        }
        cancelAnimationFrame(frame)
        frame = 0
        if (renderer && held()) {
            state = stillRing(inputs.mode)
            renderer.draw(state, pixels())
        }
    }

    // jsdom and very old engines have no IntersectionObserver: the ring then
    // counts as on screen.
    const observer = typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            onScreen = entries[entries.length - 1].isIntersecting
            sync()
        })
    observer?.observe(canvas)

    // A GPU reset or a sleeping laptop can take the context away. Cancelling
    // the default lets the browser restore it; the program is then built anew.
    const lost = (event: Event) => {
        event.preventDefault()
        renderer = null
        sync()
        onWebgl(false)
    }
    const restored = () => {
        renderer = createRingRenderer(canvas)
        renderer?.setPalette(inputs.palette)
        sync()
        if (renderer) onWebgl(true)
    }

    canvas.addEventListener('webglcontextlost', lost)
    canvas.addEventListener('webglcontextrestored', restored)
    document.addEventListener('visibilitychange', sync)
    reducedMotion?.addEventListener('change', sync)
    sync()

    return {
        update(next) {
            if (next.palette !== inputs.palette) renderer?.setPalette(next.palette)
            inputs = next
            sync()
        },
        hear(level) {
            heard = level
        },
        stop() {
            cancelAnimationFrame(frame)
            frame = 0
            observer?.disconnect()
            canvas.removeEventListener('webglcontextlost', lost)
            canvas.removeEventListener('webglcontextrestored', restored)
            document.removeEventListener('visibilitychange', sync)
            reducedMotion?.removeEventListener('change', sync)
            renderer?.dispose()
            renderer = null
        },
    }
}
