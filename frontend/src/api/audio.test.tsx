import {renderHook} from '@testing-library/react'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {handlers} from '@/mocks/handlers'
import {sampleFor} from '@/mocks/audio'
import {emitMockEvent} from '@/mocks/ipc'
import {settleIpc, spyOnIpc} from '@/test/ipc'
import {
    AUDIO_LEVELS_EVENT,
    type AudioSource,
    levelOf,
    RECORDING_AUDIO_LEVELS_EVENT,
    subscribeAudioLevel,
    useAudioLevel,
    useAudioLevelMonitoring,
} from './audio'

function recordingSample(source: AudioSource, level: number) {
    return emitMockEvent(RECORDING_AUDIO_LEVELS_EVENT, {source, ...sampleFor(level), limiter_hit: false})
}

const unsubscribes: (() => void)[] = []
afterEach(() => unsubscribes.splice(0).forEach((unsubscribe) => unsubscribe()))

function subscribe(...args: Parameters<typeof subscribeAudioLevel>) {
    unsubscribes.push(subscribeAudioLevel(...args))
}

describe('levelOf', () => {
    it('reads decibels from -50 (empty) to -16 (full)', () => {
        expect(levelOf(0, 0)).toBe(0)
        expect(levelOf(0, 10 ** (-50 / 20))).toBeCloseTo(0)
        expect(levelOf(0, 10 ** (-33 / 20))).toBeCloseTo(0.5)
        expect(levelOf(0, 10 ** (-16 / 20))).toBeCloseTo(1)
        expect(levelOf(0.9, 1)).toBe(1)
    })

    it('applies a preview gain before the decibels, never below 0.05', () => {
        const peak = 10 ** (-33 / 20)
        expect(levelOf(0, peak, 2)).toBeCloseTo(levelOf(0, peak * 2))
        expect(levelOf(0, peak, 0)).toBeCloseTo(levelOf(0, peak * 0.05))
    })

    it('does not read a chunk quieter than its energy when its peak fell between samples', () => {
        expect(levelOf(0.02, 0.001)).toBeCloseTo(levelOf(0, 0.02 * 1.45))
    })
})

describe('subscribeAudioLevel', () => {
    it('follows one source of the recording', async () => {
        const heard = vi.fn()
        subscribe({kind: 'recording', source: 'mic'}, heard)
        await settleIpc()

        await recordingSample('system', 0.9)
        await recordingSample('mic', 0.5)

        expect(heard).toHaveBeenCalledTimes(1)
        expect(heard.mock.calls[0][0]).toBeCloseTo(0.5)
    })

    it('follows the louder source with both, until that source goes quiet for long', async () => {
        const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
        const heard = vi.fn()
        subscribe({kind: 'recording', source: 'both'}, heard)
        await settleIpc()

        await recordingSample('system', 0.8)
        await recordingSample('mic', 0.3)
        expect(heard.mock.lastCall?.[0]).toBeCloseTo(0.8)

        // The computer audio stopped sending; its last sample no longer counts.
        now.mockReturnValue(1300)
        await recordingSample('mic', 0.3)
        expect(heard.mock.lastCall?.[0]).toBeCloseTo(0.3)
    })

    it('follows a named device of the preview, or the loudest of a type', async () => {
        const byName = vi.fn()
        const byType = vi.fn()
        subscribe({kind: 'device', type: 'input', device: 'Headset'}, byName)
        subscribe({kind: 'device', type: 'output'}, byType)
        await settleIpc()

        const device = (name: string, type: 'input' | 'output', level: number) => {
            const {rms, peak} = sampleFor(level)
            return {device_name: name, device_type: type, rms_level: rms, peak_level: peak, is_active: true}
        }
        await emitMockEvent(AUDIO_LEVELS_EVENT, {
            timestamp: 0,
            levels: [
                device('Built-in microphone', 'input', 0.9),
                device('Headset', 'input', 0.4),
                device('Speakers', 'output', 0.2),
                device('Monitor', 'output', 0.6),
            ],
        })

        expect(byName.mock.lastCall?.[0]).toBeCloseTo(0.4)
        expect(byType.mock.lastCall?.[0]).toBeCloseTo(0.6)
    })

    it('matches a device by a name either side contains, and falls back to its type', async () => {
        const stored = vi.fn()
        const missing = vi.fn()
        const louder = vi.fn()
        subscribe({kind: 'device', type: 'output', device: 'JBL Tune 770NC (System Audio) (output)'}, stored)
        subscribe({kind: 'device', type: 'input', device: 'Unplugged headset'}, missing)
        subscribe({kind: 'device', type: 'output', device: 'JBL Tune 770NC (System Audio)', gain: 2}, louder)
        await settleIpc()

        const {rms, peak} = sampleFor(0.4)
        const device = (device_name: string, device_type: 'input' | 'output') =>
            ({device_name, device_type, rms_level: rms, peak_level: peak, is_active: true})
        await emitMockEvent(AUDIO_LEVELS_EVENT, {
            timestamp: 0,
            levels: [device('JBL Tune 770NC (System Audio)', 'output'), device('Built-in microphone', 'input')],
        })

        expect(stored.mock.lastCall?.[0]).toBeCloseTo(0.4)
        expect(missing.mock.lastCall?.[0]).toBeCloseTo(0.4)
        expect(louder.mock.lastCall?.[0]).toBeCloseTo(levelOf(rms, peak, 2))
    })

    it('matches a named device among devices of its own type only', async () => {
        const mic = vi.fn()
        subscribe({kind: 'device', type: 'input', device: 'Headset'}, mic)
        await settleIpc()

        const device = (device_name: string, device_type: 'input' | 'output', level: number) => {
            const {rms, peak} = sampleFor(level)
            return {device_name, device_type, rms_level: rms, peak_level: peak, is_active: true}
        }
        // The output comes first, as it can from native's HashMap.
        await emitMockEvent(AUDIO_LEVELS_EVENT, {
            timestamp: 0,
            levels: [device('Headset (System Audio)', 'output', 0.8), device('Headset', 'input', 0)],
        })

        expect(mic.mock.lastCall?.[0]).toBe(0)
    })

    it('stops hearing a feed once unsubscribed', async () => {
        const heard = vi.fn()
        const unsubscribe = subscribeAudioLevel({kind: 'recording', source: 'mic'}, heard)
        await settleIpc()
        unsubscribe()

        await recordingSample('mic', 0.5)

        expect(heard).not.toHaveBeenCalled()
    })
})

describe('useAudioLevel', () => {
    it('keeps one subscription across renders with an equal feed literal', async () => {
        const ipc = spyOnIpc()
        const heard = vi.fn()
        const {rerender} = renderHook(() => useAudioLevel({kind: 'recording', source: 'mic'}, heard))
        rerender()
        rerender()
        await settleIpc()

        expect(ipc.mock.calls.filter(([command]) => command === 'plugin:event|listen')).toHaveLength(1)
        await recordingSample('mic', 0.5)
        expect(heard).toHaveBeenCalledTimes(1)
    })

    it('subscribes to nothing for a null feed', async () => {
        const heard = vi.fn()
        renderHook(() => useAudioLevel(null, heard))
        await settleIpc()

        await recordingSample('mic', 0.5)

        expect(heard).not.toHaveBeenCalled()
    })
})

describe('useAudioLevelMonitoring', () => {
    it('starts the preview while mounted and stops it after the start, on unmount', async () => {
        const calls: string[] = []
        vi.spyOn(handlers, 'start_audio_level_monitoring').mockImplementation(async ({deviceNames}) => {
            await settleIpc()
            calls.push(`start ${JSON.stringify(deviceNames)}`)
            return null
        })
        vi.spyOn(handlers, 'stop_audio_level_monitoring').mockImplementation(() => {
            calls.push('stop')
            return null
        })

        const {unmount} = renderHook(() => useAudioLevelMonitoring(['Headset']))
        // Unmounted while the start is still running: the stop waits for it.
        unmount()
        await settleIpc()
        await settleIpc()

        expect(calls).toEqual(['start ["Headset"]', 'stop'])
    })

    it('runs no preview for null', async () => {
        const start = vi.spyOn(handlers, 'start_audio_level_monitoring')
        renderHook(() => useAudioLevelMonitoring(null))
        await settleIpc()

        expect(start).not.toHaveBeenCalled()
    })
})
