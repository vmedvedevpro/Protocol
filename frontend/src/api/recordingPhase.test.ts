import {act, renderHook} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {recordingPhase, useRecordingBusy, useRecordingPhase} from './recordingPhase'

describe('the recording phase', () => {
    it('starts idle', () => {
        expect(recordingPhase.get()).toBe('idle')
        recordingPhase.set('starting')
        expect(recordingPhase.get()).toBe('starting')
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
