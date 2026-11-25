import {describe, expect, it} from 'vitest'
import {easings} from './motion'

describe('easings', () => {
    it('lets what arrives and what leaves start at once (an ease-out, never an ease-in)', () => {
        for (const name of ['enter', 'exit'] as const) {
            // The curve leaves (0,0) toward its first control point, or the
            // second when the first sits on it; steeper than linear is an ease-out start.
            const [x1, y1, x2, y2] = easings[name]
            const [x, y] = x1 === 0 && y1 === 0 ? [x2, y2] : [x1, y1]
            expect(y / x, name).toBeGreaterThan(1)
        }
    })
})
