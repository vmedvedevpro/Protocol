import {listen} from '@tauri-apps/api/event'
import {waitFor} from '@testing-library/react'
import {describe, expect, it, vi} from 'vitest'
import {type AudioLevelUpdate, levelOf, startAudioLevelMonitoring, stopAudioLevelMonitoring} from '@/api/audio'
import {MOCK_MICROPHONE, MOCK_SPEAKERS, mockLevel, sampleFor} from './audio'
import {mockState, resetMockState} from './state'

describe('fake audio levels', () => {
    it('makes samples that read back as the level asked for', () => {
        for (const level of [0, 0.25, 0.5, 1]) {
            const {rms, peak} = sampleFor(level)
            expect(levelOf(rms, peak)).toBeCloseTo(level)
        }
    })

    it('holds both sources at the level the stories set', () => {
        mockState.audio.level = 0.7
        expect(mockLevel('mic', 12)).toBe(0.7)
        expect(mockLevel('system', 12)).toBe(0.7)
    })

    it('previews the requested devices until stopped', async () => {
        const updates: AudioLevelUpdate[] = []
        const unlisten = await listen<AudioLevelUpdate>('audio-levels', (event) => updates.push(event.payload))

        await startAudioLevelMonitoring(['Headset', 'Studio Speakers'])
        await waitFor(() => expect(updates.length).toBeGreaterThan(0))
        expect(updates[0].levels.map((level) => [level.device_name, level.device_type])).toEqual([
            ['Headset', 'input'],
            ['Studio Speakers', 'output'],
        ])

        await stopAudioLevelMonitoring()
        expect(mockState.audio.monitoring).toBeNull()
        unlisten()
    })

    it('previews the default microphone and output for an empty list', async () => {
        await startAudioLevelMonitoring([])
        expect(mockState.audio.monitoring).toEqual([MOCK_MICROPHONE, MOCK_SPEAKERS])
    })

    it('ends a preview nobody stopped when the state resets', async () => {
        const update = vi.fn()
        const unlisten = await listen('audio-levels', update)
        await startAudioLevelMonitoring([])
        await waitFor(() => expect(update).toHaveBeenCalled())

        resetMockState()
        await new Promise((resolve) => setTimeout(resolve, 0))
        const sent = update.mock.calls.length
        await new Promise((resolve) => setTimeout(resolve, 250))

        expect(update).toHaveBeenCalledTimes(sent)
        unlisten()
    })
})
