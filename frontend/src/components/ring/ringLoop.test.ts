import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {lightTheme} from '@/styles/theme'
import {createRingRenderer, type RingRenderer} from './ringGl'
import {type RingLoop, startRingLoop} from './ringLoop'
import {STILL_FRAME} from './ringMotion'

// jsdom has no WebGL: a fake renderer records what the loop draws.
vi.mock('./ringGl', () => ({createRingRenderer: vi.fn()}))

let renderer: { [K in keyof RingRenderer]: ReturnType<typeof vi.fn> }
let frames: FrameRequestCallback[]
let loop: RingLoop | null
const canvas = document.createElement('canvas')
const palette = lightTheme.ring

function nextFrame(now: number) {
    const pending = frames.splice(0)
    pending.forEach((callback) => callback(now))
}

beforeEach(() => {
    renderer = {setPalette: vi.fn(), draw: vi.fn(), dispose: vi.fn()}
    vi.mocked(createRingRenderer).mockReturnValue(renderer as unknown as RingRenderer)
    frames = []
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

        loop?.hear(1)
        for (let i = 1; i <= 30; i++) nextFrame(performance.now() + i * 16)

        expect(renderer.draw).toHaveBeenCalledTimes(30)
        expect(renderer.draw.mock.lastCall?.[0].level).toBeGreaterThan(0.9)
        expect(frames).toHaveLength(1)
    })

    it('draws one still frame for the logo and runs no loop', () => {
        loop = startRingLoop(canvas, {mode: 'still', size: 96, palette}, vi.fn())

        expect(frames).toHaveLength(0)
        expect(renderer.draw).toHaveBeenCalledTimes(1)
        expect(renderer.draw.mock.lastCall?.[0]).toMatchObject({time: STILL_FRAME.time, level: STILL_FRAME.level})
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

    it('stands still under reduced motion, in its mode’s grey', () => {
        vi.spyOn(window, 'matchMedia').mockReturnValue({
            matches: true,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        } as unknown as MediaQueryList)
        loop = startRingLoop(canvas, {mode: 'paused', size: 48, palette}, vi.fn())

        expect(frames).toHaveLength(0)
        expect(renderer.draw.mock.lastCall?.[0]).toMatchObject({mono: 1, level: 0})
    })

    it('scales the canvas to the device pixels, at most twice the CSS size', () => {
        vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(3)
        loop = startRingLoop(canvas, {mode: 'still', size: 48, palette}, vi.fn())

        expect(renderer.draw.mock.lastCall?.[1]).toBe(96)
    })

    it('takes a new palette and redraws a still ring when the theme changes', () => {
        loop = startRingLoop(canvas, {mode: 'still', size: 48, palette}, vi.fn())
        const dark = {...palette, violet: '#996BFF'}
        loop?.update({mode: 'still', size: 48, palette: dark})

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
