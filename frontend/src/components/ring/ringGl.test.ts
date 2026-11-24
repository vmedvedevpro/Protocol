import {afterEach, describe, expect, it, vi} from 'vitest'
import {lightTheme} from '@/styles/theme'
import {createRingRenderer} from './ringGl'
import {restingRing} from './ringMotion'

// jsdom has no WebGL: a context that answers every call and records them.
function fakeWebgl() {
    const answers: Record<string, (...args: unknown[]) => unknown> = {
        createShader: () => ({}),
        createProgram: () => ({}),
        createBuffer: () => ({}),
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        getAttribLocation: () => 0,
        getUniformLocation: (_program, name) => name,
    }
    const calls = new Map<string, ReturnType<typeof vi.fn>>()
    return new Proxy({} as Record<string, unknown>, {
        get(_target, key) {
            if (typeof key !== 'string') return undefined
            // Constants such as VERTEX_SHADER.
            if (/^[A-Z_]+$/.test(key)) return key
            if (!calls.has(key)) calls.set(key, vi.fn(answers[key] ?? (() => undefined)))
            return calls.get(key)
        },
    }) as unknown as Record<string, ReturnType<typeof vi.fn>>
}

afterEach(() => vi.unstubAllGlobals())

describe('the ring renderer', () => {
    it('sizes a program built on a canvas that already has the right size', () => {
        vi.stubGlobal('WebGLRenderingContext', class {})
        const gl = fakeWebgl()
        const canvas = document.createElement('canvas')
        vi.spyOn(canvas, 'getContext').mockReturnValue(gl as unknown as WebGLRenderingContext)

        const first = createRingRenderer(canvas)
        first?.draw(restingRing('rec'), 96)
        // A restored context, or the second mount under StrictMode: a new
        // program on the same 96-pixel canvas.
        const second = createRingRenderer(canvas)
        second?.setPalette(lightTheme.ring)
        second?.draw(restingRing('rec'), 96)

        expect(gl.viewport).toHaveBeenCalledTimes(2)
        expect(gl.uniform2f.mock.calls).toEqual([['uRes', 96, 96], ['uRes', 96, 96]])
        // The same program at the same size does not resize again.
        second?.draw(restingRing('rec'), 96)
        expect(gl.viewport).toHaveBeenCalledTimes(2)
    })

    it('is null without WebGL', () => {
        expect(createRingRenderer(document.createElement('canvas'))).toBeNull()
    })
})
