import type {RingPalette} from '@/styles/theme'
import type {RingState} from './ringMotion'

// The shader of the design's Ring, with its colours passed in from the theme
// instead of mixed from a dark flag. One quad covers the canvas; every pixel
// works out how far it is from a circle whose edge wobbles with the level.
const VERTEX = 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'

const FRAGMENT = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform float uLevel;
uniform float uMono;
uniform vec3 uViolet;
uniform vec3 uBlue;
uniform vec3 uCyan;
uniform vec3 uHighlight;
uniform float uHalo;

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y));
    float r = length(uv);
    float a = atan(uv.y, uv.x);
    float t = uTime;
    // The edge: a slow wobble that is always there, and a faster one that
    // grows with the voice; a louder voice also widens the circle a little.
    float slow = 0.6 * sin(2.0 * a - 0.6 * t) + 0.4 * sin(3.0 * a + 0.8 * t + 1.7);
    float voice = 0.5 * sin(4.0 * a + 1.9 * t) + 0.3 * sin(6.0 * a - 2.6 * t + 1.1) + 0.2 * sin(9.0 * a + 3.3 * t + 2.4);
    float edge = 0.6 + 0.012 * slow + (0.008 + 0.075 * uLevel) * voice + 0.03 * uLevel;
    float sd = r - edge;
    // A glow that fades slowly inward and fast outward, a thin rim on the
    // edge, and a faint halo on both sides.
    float band = sd < 0.0 ? exp(sd * 7.0) : exp(-sd * 38.0);
    float rim = exp(-abs(sd) * 90.0);
    float halo = exp(-abs(sd) * 12.0);
    // A highlight that walks slowly around the circle.
    float lit = 0.5 + 0.5 * cos(a + 1.2 - 0.7 * t);
    float light = 0.35 + 0.65 * lit * lit;
    float k1 = 0.5 + 0.5 * sin(a + 0.5 * t);
    float k2 = 0.5 + 0.5 * sin(a - 0.35 * t + 2.0);
    vec3 col = mix(uViolet, uBlue, k1);
    col = mix(col, uCyan, k2 * 0.7);
    col = mix(col, uHighlight, pow(lit, 10.0) * 0.8);
    float intensity = (band * 0.75 + rim * 0.7) * light + halo * uHalo;
    intensity *= 0.85 + 0.35 * uLevel;
    float grey = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(grey), uMono);
    intensity *= 1.0 - 0.35 * uMono;
    float alpha = clamp(intensity, 0.0, 1.0);
    gl_FragColor = vec4(col * alpha, alpha);
}
`

const UNIFORMS = ['uRes', 'uTime', 'uLevel', 'uMono', 'uViolet', 'uBlue', 'uCyan', 'uHighlight', 'uHalo'] as const

type Uniforms = Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>

export interface RingRenderer {
    setPalette(palette: RingPalette): void
    /** Draws one frame on a square canvas `pixels` device pixels wide. */
    draw(state: RingState, pixels: number): void
    /** Frees the program and the buffer; the context goes with the canvas. */
    dispose(): void
}

function rgb(hex: string): [number, number, number] {
    const value = Number.parseInt(hex.slice(1), 16)
    return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255]
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
    console.error('Ring shader failed to compile:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
}

/**
 * The ring's WebGL program on `canvas`, or null when the page has no WebGL or
 * the shader does not build there; the ring then shows its static form.
 */
export function createRingRenderer(canvas: HTMLCanvasElement): RingRenderer | null {
    if (typeof WebGLRenderingContext === 'undefined') return null
    // One quad and a soft glow: no depth, no stencil, and no antialiasing,
    // which would only smooth the quad's edges, off the canvas. Low power
    // keeps a laptop on its integrated GPU for a 100-pixel ring.
    const gl = canvas.getContext('webgl', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'low-power',
    })
    if (!gl) return null

    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
    const program = gl.createProgram()
    if (!vertex || !fragment || !program) return null
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    // Linked into the program, the shaders are no longer needed on their own.
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Ring shader failed to link:', gl.getProgramInfoLog(program))
        gl.deleteProgram(program)
        return null
    }
    gl.useProgram(program)

    const quad = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.clearColor(0, 0, 0, 0)

    const uniforms = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])) as Uniforms

    return {
        setPalette(palette) {
            gl.uniform3fv(uniforms.uViolet, rgb(palette.violet))
            gl.uniform3fv(uniforms.uBlue, rgb(palette.blue))
            gl.uniform3fv(uniforms.uCyan, rgb(palette.cyan))
            gl.uniform3fv(uniforms.uHighlight, rgb(palette.highlight))
            gl.uniform1f(uniforms.uHalo, palette.halo)
        },
        draw(state, pixels) {
            if (canvas.width !== pixels) {
                canvas.width = pixels
                canvas.height = pixels
                gl.viewport(0, 0, pixels, pixels)
                gl.uniform2f(uniforms.uRes, pixels, pixels)
            }
            gl.uniform1f(uniforms.uTime, state.time)
            gl.uniform1f(uniforms.uLevel, state.level)
            gl.uniform1f(uniforms.uMono, state.mono)
            gl.clear(gl.COLOR_BUFFER_BIT)
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
        },
        dispose() {
            gl.deleteBuffer(quad)
            gl.deleteProgram(program)
        },
    }
}
