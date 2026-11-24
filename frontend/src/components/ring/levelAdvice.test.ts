import {describe, expect, it} from 'vitest'
import {LOUD_AFTER_MS, LoudMonitor, QUIET_AFTER_MS, QuietMonitor} from './levelAdvice'

const db = (value: number) => 10 ** (value / 20)
// Quiet speech: -55 dBFS RMS with -40 dBFS peaks.
const QUIET = {rms: db(-55), peak: db(-40)}

describe('QuietMonitor', () => {
    it('says Low audio after five seconds of steady quiet samples', () => {
        const monitor = new QuietMonitor()
        let low = false
        for (let at = 0; at <= QUIET_AFTER_MS; at += 40) low = monitor.update(QUIET.rms, QUIET.peak, at)
        expect(low).toBe(true)
    })

    it('starts again after a gap, a louder sample or digital silence', () => {
        const monitor = new QuietMonitor()
        for (let at = 0; at < 4_000; at += 40) monitor.update(QUIET.rms, QUIET.peak, at)
        // A 500 ms gap in the samples.
        expect(monitor.update(QUIET.rms, QUIET.peak, 4_500)).toBe(false)
        expect(monitor.update(QUIET.rms, QUIET.peak, 4_500 + QUIET_AFTER_MS - 40)).toBe(false)

        const loud = new QuietMonitor()
        for (let at = 0; at < 4_000; at += 40) loud.update(QUIET.rms, QUIET.peak, at)
        loud.update(db(-20), db(-10), 4_000)
        expect(loud.update(QUIET.rms, QUIET.peak, 5_040)).toBe(false)

        expect(new QuietMonitor().update(db(-90), db(-85), 0)).toBe(false)
    })

    it('never counts a bad sample as quiet', () => {
        const monitor = new QuietMonitor()
        expect(monitor.update(Number.NaN, QUIET.peak, 0)).toBe(false)
        // A peak below its RMS is not a real sample.
        expect(monitor.update(QUIET.rms, QUIET.rms / 2, 0)).toBe(false)
    })
})

describe('LoudMonitor', () => {
    it('says Too loud once limiter hits keep coming for 750 ms', () => {
        const monitor = new LoudMonitor()
        let loud = false
        for (let at = 0; at <= LOUD_AFTER_MS + 100; at += 100) loud = monitor.hit(at)
        expect(loud).toBe(true)
    })

    it('ignores hits too far apart', () => {
        const monitor = new LoudMonitor()
        let loud = false
        for (let at = 0; at <= 3_000; at += 300) loud = monitor.hit(at)
        expect(loud).toBe(false)
    })
})
