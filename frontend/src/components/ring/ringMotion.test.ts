import {describe, expect, it} from 'vitest'
import {advanceRing, restingRing, type RingMode, type RingState, STILL_FRAME, stillRing} from './ringMotion'

function run(mode: RingMode, heard: number, seconds: number, from: RingState = restingRing('rec')) {
    let state = from
    for (let frame = 0; frame < seconds * 60; frame++) state = advanceRing(state, mode, heard, frame / 60, 1 / 60)
    return state
}

describe('ring motion', () => {
    it('follows the level in rec and exaggerates it in test', () => {
        expect(run('rec', 0.5, 2).level).toBeCloseTo(0.5)
        expect(run('test', 0.5, 2).level).toBeCloseTo(0.625)
        expect(run('test', 0.9, 2).level).toBeCloseTo(1)
    })

    it('flattens and greys when paused, and runs its clock slowly', () => {
        const paused = run('paused', 0.8, 2, {time: 0, level: 0.6, mono: 0})
        expect(paused.level).toBeCloseTo(0)
        expect(paused.mono).toBeCloseTo(1)
        expect(paused.time).toBeCloseTo(0.3)
    })

    it('breathes on its own when idle, whatever it hears', () => {
        const idle = run('idle', 1, 2)
        expect(idle.level).toBeLessThan(0.08)
        expect(idle.mono).toBeCloseTo(0.55)
    })

    it('eases at the same speed whatever the frame rate', () => {
        const from = {time: 0, level: 0, mono: 0}
        const twoFrames = advanceRing(advanceRing(from, 'rec', 1, 0, 1 / 60), 'rec', 1, 0, 1 / 60)
        const oneFrame = advanceRing(from, 'rec', 1, 0, 2 / 60)
        expect(oneFrame.level).toBeCloseTo(twoFrames.level)
    })

    it('starts settled in its mode and stands still on the logo frame', () => {
        expect(restingRing('paused').mono).toBe(1)
        expect(stillRing('still')).toEqual({time: STILL_FRAME.time, level: STILL_FRAME.level, mono: 0})
        expect(stillRing('paused')).toEqual({time: STILL_FRAME.time, level: 0, mono: 1})
    })
})
