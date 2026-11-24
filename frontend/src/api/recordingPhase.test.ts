import {act, renderHook} from '@testing-library/react'
import {describe, expect, it, vi} from 'vitest'
import {recordingPhase, useRecordingBusy, useRecordingPhase} from './recordingPhase'

describe('the recording phase', () => {
    it('starts idle and tells subscribers of each change, once', () => {
        expect(recordingPhase.get()).toBe('idle')
        const listener = vi.fn()
        const stop = recordingPhase.subscribe(listener)
        recordingPhase.set('starting')
        recordingPhase.set('starting')
        recordingPhase.set('recording')
        stop()
        recordingPhase.set('idle')
        expect(listener.mock.calls).toEqual([['starting'], ['recording']])
    })

    it('re-renders its readers', () => {
        const {result} = renderHook(() => ({phase: useRecordingPhase(), busy: useRecordingBusy()}))
        expect(result.current).toEqual({phase: 'idle', busy: false})
        act(() => recordingPhase.set('paused'))
        expect(result.current).toEqual({phase: 'paused', busy: true})
        act(() => recordingPhase.set('finishing'))
        expect(result.current.busy).toBe(true)
    })
})
