/**
 * Draws Protocol's app icons and its tray and menu bar icons from the ring
 * logo (#120) and writes them to src-tauri/icons. Run it from frontend/ after
 * changing a number below:
 *
 *     node scripts/build-icons.mjs
 *
 * The output is deterministic: a rerun with the same numbers leaves git clean.
 *
 * The logo is one frame of the recording ring's shader
 * (src/components/ring/ringGl.ts), which SVG cannot draw: it has no conic
 * gradient and no light that changes along the ring. So this script is the
 * source. It evaluates the shader and the flat ring per pixel, supersampled,
 * and encodes PNG, ICO and ICNS itself, so it needs nothing but Node.
 * docs: ARCHITECTURE.md › Branding assets.
 */

import {mkdirSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {deflateSync} from 'node:zlib'

const ICONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons')

// ── The mark ────────────────────────────────────────────────────────────────

/** theme.ts › ring.dark: the ring as it is drawn on black, which the icon's plate is. */
const RING = {violet: '#996BFF', blue: '#5C94FF', cyan: '#6BE0FA', highlight: '#FFFFFF', halo: 0.22}
/** The design's frozen frame: the highlight at the top left, the edge calm but alive. */
const FRAME = {time: 5.08, level: 0.18}
/** The glow image is 1.08 plates wide, so the plate's corners cut the faint halo, not the ring. */
const GLOW_SCALE = 1.08
/**
 * Plates of 32 px and less get StaticRing's flat ring instead of the glow,
 * which blurs into a smudge there: 64 % of the plate wide, its stroke a tenth
 * of the plate but at least 1.6 px, with a 0.8 px soft inner edge.
 */
const FLAT = {maxPlate: 32, diameter: 0.64, stroke: 0.1, minStroke: 1.6, feather: 0.8}
/**
 * Plates: Apple's grid on macOS (824 of 1024 with a drop shadow, as the
 * system draws no shadow of its own), the whole icon on Windows and Linux
 * (an outer shadow would not fit). A hairline of 10 % white keeps the black
 * plate apart from a black desktop.
 */
const PLATE = {
    mac: {share: 824 / 1024, radius: 0.225, shadowY: 0.012, shadowBlur: 0.024, shadowAlpha: 0.28},
    full: {share: 1, radius: 0.2},
    hairline: 0.1,
}
/**
 * The tray mark, in the design's 32-unit box (drawn at twice the size it
 * shows at): a ring 24 wide with a 2.6 stroke, a faint light band inside it
 * from 45 % of its radius out so it still reads as the logo, and an 8 wide dot
 * while a recording is on. One colour, like the system's own icons.
 */
const TRAY = {radius: 12, stroke: 2.6, feather: 0.7, bandFrom: 0.45, dot: 4}

const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
const VIOLET = hex(RING.violet)
const BLUE = hex(RING.blue)
const CYAN = hex(RING.cyan)
const HIGHLIGHT = hex(RING.highlight)
const mix = (a, b, t) => a + (b - a) * t
const clamp01 = (x) => Math.min(1, Math.max(0, x))

/**
 * ringGl.ts's fragment shader at FRAME, without the grey of idle or pause.
 * (u, v) spans -1..1 across the glow image with v pointing up, as
 * gl_FragCoord does. Returns premultiplied RGBA.
 */
function shader(u, v) {
    const {time: t, level} = FRAME
    const r = Math.hypot(u, v)
    const a = Math.atan2(v, u)
    const slow = 0.6 * Math.sin(2 * a - 0.6 * t) + 0.4 * Math.sin(3 * a + 0.8 * t + 1.7)
    const voice = 0.5 * Math.sin(4 * a + 1.9 * t) + 0.3 * Math.sin(6 * a - 2.6 * t + 1.1)
        + 0.2 * Math.sin(9 * a + 3.3 * t + 2.4)
    const sd = r - (0.6 + 0.012 * slow + (0.008 + 0.075 * level) * voice + 0.03 * level)
    const band = sd < 0 ? Math.exp(sd * 7) : Math.exp(-sd * 38)
    const rim = Math.exp(-Math.abs(sd) * 90)
    const halo = Math.exp(-Math.abs(sd) * 12)
    const lit = 0.5 + 0.5 * Math.cos(a + 1.2 - 0.7 * t)
    const light = 0.35 + 0.65 * lit * lit
    const k1 = 0.5 + 0.5 * Math.sin(a + 0.5 * t)
    const k2 = 0.5 + 0.5 * Math.sin(a - 0.35 * t + 2)
    const shine = lit ** 10 * 0.8
    const alpha = clamp01(((band * 0.75 + rim * 0.7) * light + halo * RING.halo) * (0.85 + 0.35 * level))
    const out = [0, 0, 0, alpha]
    for (let c = 0; c < 3; c++) {
        out[c] = mix(mix(mix(VIOLET[c], BLUE[c], k1), CYAN[c], k2 * 0.7), HIGHLIGHT[c], shine) * alpha
    }
    return out
}

/**
 * StaticRing's `conic-gradient(from 200deg, violet, blue 40%, cyan 70%,
 * violet)` at an offset from the centre (y down): CSS angles run clockwise
 * from twelve o'clock.
 */
function conic(dx, dy) {
    const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI
    const p = ((((degrees - 200) % 360) + 360) % 360) / 360
    const [from, to, t] = p < 0.4 ? [VIOLET, BLUE, p / 0.4] : p < 0.7 ? [BLUE, CYAN, (p - 0.4) / 0.3] : [CYAN, VIOLET, (p - 0.7) / 0.3]
    return from.map((value, c) => mix(value, to[c], t))
}

/** Signed distance from a rounded square centred on (c, c): negative inside. */
function roundedSquare(x, y, c, half, radius) {
    const qx = Math.abs(x - c) - (half - radius)
    const qy = Math.abs(y - c) - (half - radius)
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}

/** Subsamples per axis: enough to resolve the 1/90 rim on small icons, cheap on large ones. */
const samplesFor = (size) => (size <= 64 ? 8 : size <= 256 ? 4 : 3)

/** Averages `paint(x, y)` (premultiplied RGBA at a point, y down) over each pixel. */
function rasterize(size, paint) {
    const n = samplesFor(size)
    const pixels = new Float64Array(size * size * 4)
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            const at = (py * size + px) * 4
            for (let j = 0; j < n; j++) {
                for (let i = 0; i < n; i++) {
                    const rgba = paint(px + (i + 0.5) / n, py + (j + 0.5) / n)
                    for (let c = 0; c < 4; c++) pixels[at + c] += rgba[c]
                }
            }
            for (let c = 0; c < 4; c++) pixels[at + c] /= n * n
        }
    }
    return pixels
}

const CLEAR = [0, 0, 0, 0]

/** One app icon `size` px wide, on the macOS grid or (`mac` false) the full plate. */
function appIcon(size, mac) {
    const plate = mac ? Math.round(size * PLATE.mac.share) : size
    const radius = plate * (mac ? PLATE.mac.radius : PLATE.full.radius)
    const c = size / 2
    // A hairline is one pixel at the size it is shown; the 1024 px entry is 512 pt at 2x.
    const hairline = Math.max(1, size / 512)
    const flat = plate <= FLAT.maxPlate
    const glowHalf = Math.round(plate * GLOW_SCALE) / 2
    const ringRadius = Math.round(plate * FLAT.diameter) / 2
    const stroke = Math.max(FLAT.minStroke, plate * FLAT.stroke)

    const pixels = rasterize(size, (x, y) => {
        const d = roundedSquare(x, y, c, plate / 2, radius)
        if (d > 0) return CLEAR
        // The inset hairline lies under the ring, as CSS paints an inset shadow under the content.
        const base = d > -hairline ? PLATE.hairline : 0
        let src
        if (flat) {
            const r = Math.hypot(x - c, y - c)
            const alpha = r <= ringRadius ? clamp01((r - (ringRadius - stroke)) / FLAT.feather) : 0
            src = [...conic(x - c, y - c).map((value) => value * alpha), alpha]
        } else {
            src = shader((x - c) / glowHalf, -(y - c) / glowHalf)
        }
        return [0, 1, 2].map((ch) => src[ch] + base * (1 - src[3])).concat(1)
    })

    if (mac) dropShadow(pixels, size, plate, radius)
    return pixels
}

/** Lays CSS's `0 Y B rgba(0, 0, 0, a)` box-shadow of the plate under it; a blur of B is a Gaussian of B / 2. */
function dropShadow(pixels, size, plate, radius) {
    const {shadowY, shadowBlur, shadowAlpha} = PLATE.mac
    const c = size / 2
    const offset = size * shadowY
    const mask = rasterize(size, (x, y) => (roundedSquare(x, y - offset, c, plate / 2, radius) <= 0 ? [0, 0, 0, 1] : CLEAR))
    const sigma = (size * shadowBlur) / 2
    const reach = Math.max(1, Math.ceil(sigma * 3))
    const kernel = Array.from({length: reach * 2 + 1}, (_, k) => Math.exp(-((k - reach) ** 2) / (2 * sigma * sigma)))
    const sum = kernel.reduce((a, b) => a + b, 0)
    const alpha = Float64Array.from({length: size * size}, (_, k) => mask[k * 4 + 3])
    const blur = (source, along) => Float64Array.from({length: size * size}, (_, k) => {
        const x = k % size
        const y = Math.floor(k / size)
        let total = 0
        for (let t = -reach; t <= reach; t++) {
            const sx = along === 'x' ? x + t : x
            const sy = along === 'y' ? y + t : y
            if (sx >= 0 && sx < size && sy >= 0 && sy < size) total += source[sy * size + sx] * kernel[t + reach]
        }
        return total / sum
    })
    const shadow = blur(blur(alpha, 'x'), 'y')
    for (let k = 0; k < size * size; k++) {
        const below = shadow[k] * shadowAlpha
        pixels[k * 4 + 3] += below * (1 - pixels[k * 4 + 3])
    }
}

/**
 * The tray mark on a `size` px square, the 32-unit box drawn at `unit` px per
 * unit in its middle. `ink` 1 is white, 0 black; `band` the light band's
 * strength.
 */
function trayIcon(size, unit, ink, band, recording) {
    const c = size / 2
    const outer = TRAY.radius * unit
    const inner = (TRAY.radius - TRAY.stroke) * unit
    const feather = TRAY.feather * unit
    const dot = TRAY.dot * unit
    return rasterize(size, (x, y) => {
        const r = Math.hypot(x - c, y - c)
        if (r > outer) return CLEAR
        const light = band * clamp01((r / outer - TRAY.bandFrom) / (1 - TRAY.bandFrom))
        const ring = clamp01((r - inner) / feather)
        const centre = recording && r <= dot ? 1 : 0
        const alpha = 1 - (1 - light) * (1 - ring) * (1 - centre)
        return [ink * alpha, ink * alpha, ink * alpha, alpha]
    })
}

// ── Encoding ────────────────────────────────────────────────────────────────

/** Premultiplied floats to straight 8-bit RGBA, as PNG and ICNS keep it. */
function toBytes(pixels) {
    const bytes = Buffer.alloc(pixels.length)
    for (let k = 0; k < pixels.length; k += 4) {
        const alpha = Math.round(clamp01(pixels[k + 3]) * 255)
        if (alpha === 0) continue
        for (let c = 0; c < 3; c++) bytes[k + c] = Math.round(clamp01(pixels[k + c] / pixels[k + 3]) * 255)
        bytes[k + 3] = alpha
    }
    return bytes
}

const CRC_TABLE = Array.from({length: 256}, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
})

function crc32(buffer) {
    let c = 0xffffffff
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

const u32be = (value) => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(value)
    return buffer
}

function png(size, rgba) {
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
        return Buffer.concat([u32be(data.length), body, u32be(crc32(body))])
    }
    const header = Buffer.concat([u32be(size), u32be(size), Buffer.from([8, 6, 0, 0, 0])])
    // Every row unfiltered (filter byte 0): simple, and the size does not matter here.
    const stride = size * 4
    const rows = Buffer.alloc((stride + 1) * size)
    for (let y = 0; y < size; y++) rgba.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(rows, {level: 9})),
        chunk('IEND', Buffer.alloc(0)),
    ])
}

/** An ICO of PNG entries, which Windows reads since Vista and NSIS takes as the installer icon. */
function ico(entries) {
    const header = Buffer.alloc(6 + entries.length * 16)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(entries.length, 4)
    let offset = header.length
    entries.forEach(({size, data}, k) => {
        const at = 6 + k * 16
        header[at] = size >= 256 ? 0 : size
        header[at + 1] = size >= 256 ? 0 : size
        header.writeUInt16LE(1, at + 4)
        header.writeUInt16LE(32, at + 6)
        header.writeUInt32LE(data.length, at + 8)
        header.writeUInt32LE(offset, at + 12)
        offset += data.length
    })
    return Buffer.concat([header, ...entries.map((entry) => entry.data)])
}

/**
 * ICNS's legacy 16 and 32 px pair (is32 + s8mk, il32 + l8mk): each colour
 * plane packed in literal runs of up to 128 bytes, then the 8-bit mask.
 */
function legacyIcns(rgba) {
    const planes = [0, 1, 2].map((c) => {
        const plane = Buffer.from(Array.from({length: rgba.length / 4}, (_, k) => rgba[k * 4 + c]))
        const runs = []
        for (let k = 0; k < plane.length; k += 128) {
            const run = plane.subarray(k, k + 128)
            runs.push(Buffer.from([run.length - 1]), run)
        }
        return Buffer.concat(runs)
    })
    const mask = Buffer.from(Array.from({length: rgba.length / 4}, (_, k) => rgba[k * 4 + 3]))
    return {color: Buffer.concat(planes), mask}
}

function icns(entries) {
    const body = Buffer.concat(entries.map(({type, data}) => Buffer.concat([Buffer.from(type, 'ascii'), u32be(data.length + 8), data])))
    return Buffer.concat([Buffer.from('icns', 'ascii'), u32be(body.length + 8), body])
}

// ── The files ───────────────────────────────────────────────────────────────

const renders = new Map()
/** The RGBA bytes of an app icon, drawn once per size and grid. */
function appBytes(size, mac) {
    const key = `${size}${mac ? 'mac' : 'full'}`
    if (!renders.has(key)) renders.set(key, toBytes(appIcon(size, mac)))
    return renders.get(key)
}

function write(name, data) {
    const path = join(ICONS, name)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, data)
    console.log(`${name.padEnd(40)} ${data.length} bytes`)
}

// Windows and Linux: the PNG family Tauri's bundle config lists (the Linux
// packages' hicolor sizes and the default window icon), and the Windows .ico.
const FULL = {
    '32x32.png': 32,
    '64x64.png': 64,
    '128x128.png': 128,
    '128x128@2x.png': 256,
    'icon.png': 512,
}
for (const [name, size] of Object.entries(FULL)) write(name, png(size, appBytes(size, false)))

// Small icons (title bar, tray overflow, Explorer lists) at 100-200 % scale,
// the taskbar at 100-200 %, and Explorer's large views.
write('icon.ico', ico([16, 20, 24, 32, 48, 64, 128, 256].map((size) => ({size, data: png(size, appBytes(size, false))}))))

// macOS: every size of an .iconset, 16 pt to 512 pt at 1x and 2x.
const small = legacyIcns(appBytes(16, true))
const medium = legacyIcns(appBytes(32, true))
write('icon.icns', icns([
    {type: 'is32', data: small.color},
    {type: 's8mk', data: small.mask},
    {type: 'il32', data: medium.color},
    {type: 'l8mk', data: medium.mask},
    ...[
        ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256],
        ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024],
    ].map(([type, size]) => ({type, data: png(size, appBytes(size, true))})),
]))

// Tray and menu bar (src-tauri/src/tray/icon.rs picks one):
// - macOS: a template image, which the system tints for the menu bar. Its
//   18 pt height (tray-icon's) holds the 16 pt box with a point to spare on
//   each side, at 2x. One band strength serves light and dark bars: between
//   the design's 0.2 and 0.28.
// - Windows: the box at 2x for the 16 px slot, white for a dark taskbar,
//   black for a light one, with the design's band strengths.
// - Linux: the same at 4x, as panels scale to their own size (22 to 44 px).
const TRAY_SETS = [
    {prefix: 'macos-template', size: 36, unit: 1, ink: 0, band: 0.24},
    {prefix: 'windows-white', size: 32, unit: 1, ink: 1, band: 0.28},
    {prefix: 'windows-black', size: 32, unit: 1, ink: 0, band: 0.2},
    {prefix: 'linux-white', size: 64, unit: 2, ink: 1, band: 0.28},
    {prefix: 'linux-black', size: 64, unit: 2, ink: 0, band: 0.2},
]
for (const {prefix, size, unit, ink, band} of TRAY_SETS) {
    write(`tray/${prefix}.png`, png(size, toBytes(trayIcon(size, unit, ink, band, false))))
    write(`tray/${prefix}-recording.png`, png(size, toBytes(trayIcon(size, unit, ink, band, true))))
}
