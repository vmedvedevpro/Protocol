import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {lightTheme} from '@/styles/theme'
import {createRingRenderer, type RingRenderer} from './ringGl'
import {type RingLoop, startRingLoop} from './ringLoop'
import {STILL_FRAME} from './ringMotion'

// jsdom has no WebGL: a fake renderer records what the loop draws.
vi.mock('./ringGl', () => ({createRingRenderer: vi.fn()}))

let renderer: { [K in keyof RingRenderer]: ReturnType<typeof vi.fn> }
let frames: FrameRequestCallback[]
// performance.now() and the frames' timestamps, in ms.
let clock: number
let loop: RingLoop | null
const canvas = document.createElement('canvas')
const palette = lightTheme.ring

function reduceMotion() {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    } as unknown as MediaQueryList)
}

/** Runs the pending frame 16 ms after the last one. */
function nextFrame() {
    clock += 16
    frames.splice(0).forEach((callback) => callback(clock))
}

const drawnLevel = () => renderer.draw.mock.lastCall?.[0].level as number

beforeEach(() => {
    renderer = {setPalette: vi.fn(), draw: vi.fn(), dispose: vi.fn()}
    vi.mocked(createRingRenderer).mockReturnValue(renderer as unknown as RingRenderer)
    frames = []
    clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => frames.splice(0))
})

afterEach(() => {
    loop?.stop()
    loop = null
})

describe('the ring frame loop', () => {
    it('draws every frame while recording, following what it hears', () => {
        loop = startRingLoop(canvas, {mode: 'rec', size: 48, palette}, vi.fn())
        expect(frames).toHaveLength(1)

        for (let i = 0; i < 30; i++) {
            loop?.hear(1)
            nextFrame()
        }

        expect(renderer.draw).toHaveBeenCalledTimes(30)
        expect(drawnLevel()).toBeGreaterThan(0.9)
        expect(frames).toHaveLength(1)
    })

    it('lets the edge fall back once no sample came for 300 ms', () => {
        loop = startRingLoop(canvas, {mode: 'rec', size: 48, palette}, vi.fn())

        loop?.hear(1)
        for (let i = 0; i < 18; i++) nextFrame()
        expect(drawnLevel()).toBeGreaterThan(0.85)

        for (let i = 0; i < 40; i++) nextFrame()
        expect(drawnLevel()).toBeLessThan(0.05)
    })

    it('stops while the document is hidden and resumes after', () => {
        loop = startRingLoop(canvas, {mode: 'rec', size: 48, palette}, vi.fn())
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
        document.dispatchEvent(new Event('visibilitychange'))
        expect(frames).toHaveLength(0)

        hidden.mockReturnValue(false)
        document.dispatchEvent(new Event('visibilitychange'))
        expect(frames).toHaveLength(1)
    })

    it('draws one frame under reduced motion, in its mode’s grey, and runs no loop', () => {
        reduceMotion()
        loop = startRingLoop(canvas, {mode: 'rec', size: 48, palette}, vi.fn())
        expect(frames).toHaveLength(0)
        expect(renderer.draw).toHaveBeenCalledTimes(1)
        expect(renderer.draw.mock.lastCall?.[0]).toMatchObject({time: STILL_FRAME.time, level: STILL_FRAME.level, mono: 0})

        loop?.update({mode: 'paused', size: 48, palette})
        expect(renderer.draw.mock.lastCall?.[0]).toMatchObject({mono: 1, level: 0})
    })

    it('scales the canvas to the device pixels, at most twice the CSS size', () => {
        vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(3)
        reduceMotion()
        loop = startRingLoop(canvas, {mode: 'paused', size: 48, palette}, vi.fn())

        expect(renderer.draw.mock.lastCall?.[1]).toBe(96)
    })

    it('takes a new palette and redraws a ring held still when the theme changes', () => {
        reduceMotion()
        loop = startRingLoop(canvas, {mode: 'paused', size: 48, palette}, vi.fn())
        const dark = {...palette, violet: '#996BFF'}
        loop?.update({mode: 'paused', size: 48, palette: dark})

        expect(renderer.setPalette).toHaveBeenLastCalledWith(dark)
        expect(renderer.draw).toHaveBeenCalledTimes(2)
    })

    it('reports a lost context and builds the program again when it returns', () => {
        const onWebgl = vi.fn()
        loop = startRingLoop(canvas, {mode: 'rec', size: 48, palette}, onWebgl)

        canvas.dispatchEvent(new Event('webglcontextlost', {cancelable: true}))
        expect(onWebgl).toHaveBeenLastCalledWith(false)
        expect(frames).toHaveLength(0)

        canvas.dispatchEvent(new Event('webglcontextrestored'))
        expect(onWebgl).toHaveBeenLastCalledWith(true)
        expect(createRingRenderer).toHaveBeenCalledTimes(2)
        expect(frames).toHaveLength(1)
    })

    it('returns null without WebGL', () => {
        vi.mocked(createRingRenderer).mockReturnValue(null)
        expect(startRingLoop(canvas, {mode: 'rec', size: 48, palette}, vi.fn())).toBeNull()
    })
})
