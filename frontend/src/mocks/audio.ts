import {emit} from '@tauri-apps/api/event'
import {
    AUDIO_LEVELS_EVENT,
    type AudioLevelUpdate,
    type AudioSource,
    type DeviceAudioLevel,
    FULL_DB,
    RECORDING_AUDIO_LEVELS_EVENT,
    type RecordingAudioLevels,
    RMS_TO_PEAK,
    SILENCE_DB,
} from '@/api/audio'
import type {NativeEvent} from '@/api/events'
import type {MockArgs, MockHandler} from './handlers'
import {mockState} from './state'

/**
 * Fake audio levels, so the ring and the meters move in `pnpm dev` and
 * Storybook. Two people take turns, as in the design's mock: your microphone
 * rises while the computer audio falls. `mockState.audio.level` (the stories'
 * slider) holds both at one level instead. Tests emit their own samples.
 */

export const MOCK_MICROPHONE = 'MacBook Pro Microphone'
export const MOCK_SPEAKERS = 'MacBook Pro Speakers'

// Native sends about 25 recording samples a second per source, and the device
// preview about 12 updates a second.
const RECORDING_INTERVAL_MS = 40
const PREVIEW_INTERVAL_MS = 80

/** The design's mock voice at `t` seconds: syllables over slower phrases, 0 to 1. */
function voice(t: number): number {
    const phrase = 0.55 * Math.max(0, Math.sin(t * 1.7) * Math.sin(t * 0.63 + 1.0))
    const syllables = 0.4 * Math.max(0, Math.sin(t * 6.1 + 2.0 * Math.sin(t * 1.3)))
    return Math.min(1, 0.12 + phrase + syllables)
}

/** The level (0 to 1) of `source` at `t` seconds. */
export function mockLevel(source: AudioSource, t: number): number {
    if (mockState.audio.level !== null) return mockState.audio.level
    const yourTurn = 0.5 + 0.5 * Math.sin(t * 0.9)
    return source === 'mic' ? yourTurn * voice(t) : (1 - yourTurn) * voice(t + 3.1)
}

/**
 * RMS and peak that `levelOf` (src/api/audio.ts) reads back as `level`: the
 * inverse of its decibel scale, with the peak at the amplitude and the RMS
 * below it.
 */
export function sampleFor(level: number): { rms: number; peak: number } {
    const db = SILENCE_DB + level * (FULL_DB - SILENCE_DB)
    const amplitude = 10 ** (db / 20)
    return {rms: amplitude / RMS_TO_PEAK, peak: amplitude}
}

function send<T>(event: NativeEvent<T>, payload: T) {
    // After clearMocks() at the end of a test there is no IPC to send to.
    emit(event, payload).catch(() => undefined)
}

let recordingTimer: ReturnType<typeof setInterval> | undefined

/**
 * Emits `recording-audio-levels` for both sources from now on, as if a
 * recording were running, while the page is visible. installMockIpc() starts
 * it outside tests; the recording mock (#112) can tie it to its session.
 */
export function startMockRecordingLevels() {
    if (recordingTimer !== undefined) return
    recordingTimer = setInterval(() => {
        if (document.hidden) return
        const t = performance.now() / 1000
        for (const source of ['mic', 'system'] as const) {
            const sample: RecordingAudioLevels = {source, ...sampleFor(mockLevel(source, t)), limiter_hit: false}
            send(RECORDING_AUDIO_LEVELS_EVENT, sample)
        }
    }, RECORDING_INTERVAL_MS)
}

let previewTimer: ReturnType<typeof setInterval> | undefined

function previewUpdate(names: readonly string[]): AudioLevelUpdate {
    const t = performance.now() / 1000
    const levels = names.map((name): DeviceAudioLevel => {
        const type = /speaker|headphone|output/i.test(name) ? 'output' : 'input'
        const {rms, peak} = sampleFor(mockLevel(type === 'input' ? 'mic' : 'system', t))
        return {device_name: name, device_type: type, rms_level: rms, peak_level: peak, is_active: true}
    })
    return {timestamp: Date.now(), levels}
}

// The timer runs while mockState.audio.monitoring names devices, so a reset
// between tests or stories also ends a preview nobody stopped.
function runPreview() {
    if (previewTimer !== undefined) return
    previewTimer = setInterval(() => {
        const names = mockState.audio.monitoring
        if (names === null) {
            clearInterval(previewTimer)
            previewTimer = undefined
            return
        }
        if (!document.hidden) send(AUDIO_LEVELS_EVENT, previewUpdate(names))
    }, PREVIEW_INTERVAL_MS)
}

/** src-tauri/src/lib.rs, audio::simple_level_monitor */
export const audioHandlers: Record<string, MockHandler> = {
    start_audio_level_monitoring: ({deviceNames}: MockArgs) => {
        if (!Array.isArray(deviceNames)) {
            throw 'invalid args `deviceNames` for command `start_audio_level_monitoring`: command start_audio_level_monitoring missing required key deviceNames'
        }
        mockState.audio.monitoring = deviceNames.length > 0 ? deviceNames.map(String) : [MOCK_MICROPHONE, MOCK_SPEAKERS]
        runPreview()
        return null
    },
    stop_audio_level_monitoring: () => {
        mockState.audio.monitoring = null
        return null
    },
}
