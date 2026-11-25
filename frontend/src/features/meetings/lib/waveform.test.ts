import {describe, expect, it} from 'vitest'
import {waveformBars, waveformPath} from './waveform'

describe('waveformBars', () => {
    it('keeps the loudest second of each bar and scales to the loudest bar', () => {
        expect(waveformBars([0.1, 0.4, 0.2, 0.1], 2)).toEqual([1, Math.sqrt(0.5)])
    })

    it('draws no more bars than seconds, and none for no peaks', () => {
        expect(waveformBars([0.5, 0.5], 10)).toHaveLength(2)
        expect(waveformBars([], 10)).toEqual([])
    })

    it('keeps a near-silent recording low', () => {
        expect(waveformBars([0.01, 0.01], 2)[0]).toBeCloseTo(Math.sqrt(0.2))
    })
})

describe('waveformPath', () => {
    it('draws one rectangle per bar, at least 2 px tall', () => {
        const path = waveformPath([1, 0], 6, 28)
        expect(path.match(/M/g)).toHaveLength(2)
        expect(path).toContain('v2.0')
        expect(waveformPath([], 6, 28)).toBe('')
    })
})
