import {act, renderHook} from '@testing-library/react'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {RECORDING_AUDIO_LEVELS_EVENT} from '@/api/audio'
import {emitMockEvent} from '@/mocks/ipc'
import {settleIpc} from '@/test/ipc'
import {LOUD_EXPIRES_MS, useSystemAudioWarning} from './levelAdvice'

afterEach(() => {
    vi.useRealTimers()
})

describe('useSystemAudioWarning', () => {
    it('says Too loud while the limiter keeps clipping computer audio, and clears after it stops', async () => {
        const {result} = renderHook(() => useSystemAudioWarning(true))
        await settleIpc()
        const start = performance.now()
        const now = vi.spyOn(performance, 'now')
        for (let at = 0; at <= 800; at += 100) {
            now.mockReturnValue(start + at)
            await act(() => emitMockEvent(RECORDING_AUDIO_LEVELS_EVENT, {source: 'system', rms: 0.5, peak: 1, limiter_hit: true}))
        }
        // The microphone's samples never count.
        await act(() => emitMockEvent(RECORDING_AUDIO_LEVELS_EVENT, {source: 'mic', rms: 0.5, peak: 1, limiter_hit: false}))
        expect(result.current).toBe('loud')
        now.mockRestore()

        await act(() => new Promise((resolve) => setTimeout(resolve, LOUD_EXPIRES_MS + 50)))
        expect(result.current).toBeNull()
    })

    it('says nothing while off', async () => {
        const {result} = renderHook(() => useSystemAudioWarning(false))
        await settleIpc()
        await act(() => emitMockEvent(RECORDING_AUDIO_LEVELS_EVENT, {source: 'system', rms: 0.5, peak: 1, limiter_hit: true}))
        expect(result.current).toBeNull()
    })
})
