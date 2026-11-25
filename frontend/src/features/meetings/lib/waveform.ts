/**
 * `peaks` (one per second, 0 to 1) squeezed into `bins` bars of 0 to 1, each
 * the loudest second it covers, scaled to the recording's loudest moment so
 * a quiet meeting still shows its shape. The square root lifts quiet speech
 * above the silence between words.
 */
export function waveformBars(peaks: readonly number[], bins: number): number[] {
    if (peaks.length === 0 || bins <= 0) return []
    const count = Math.min(bins, peaks.length)
    const bars: number[] = []
    for (let index = 0; index < count; index++) {
        const start = Math.floor((index * peaks.length) / count)
        const end = Math.max(start + 1, Math.floor(((index + 1) * peaks.length) / count))
        let loudest = 0
        for (let second = start; second < end; second++) loudest = Math.max(loudest, peaks[second] ?? 0)
        bars.push(loudest)
    }
    // A floor keeps a silent recording flat instead of blowing noise up to full height.
    const top = Math.max(0.05, ...bars)
    return bars.map((value) => Math.sqrt(Math.min(1, value / top)))
}

/** The bars as one SVG path, a bar of up to 2 px per `width / bars` step, centred on the line. */
export function waveformPath(bars: readonly number[], width: number, height: number): string {
    if (bars.length === 0 || width <= 0) return ''
    const step = width / bars.length
    const bar = Math.max(1, Math.min(step - 1, 2))
    return bars.map((value, index) => {
        const tall = Math.max(2, value * height)
        const x = index * step + (step - bar) / 2
        const y = (height - tall) / 2
        return `M${x.toFixed(1)} ${y.toFixed(1)}h${bar.toFixed(1)}v${tall.toFixed(1)}h-${bar.toFixed(1)}z`
    }).join('')
}
