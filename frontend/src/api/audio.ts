/**
 * Audio levels that native code pushes while it captures sound: per source
 * during a recording (`recording-audio-levels`), and per device while a
 * device preview runs (`start_audio_level_monitoring`, `audio-levels`). They
 * arrive 12 to 25 times a second, so they skip Query and React state
 * (docs/UI_ARCHITECTURE.md, Styling): the ring and the meters subscribe with
 * `useAudioLevel` and draw through a canvas or a ref. The payload types mirror
 * `AudioLevels` in audio/pipeline.rs and `AudioLevelUpdate` in
 * audio/simple_level_monitor.rs.
 *
 * This domain file also holds the two hooks, as events.ts does: every screen
 * that shows a level (recording bar, minibar, mic test) needs them.
 */
import {useEffect, useEffectEvent} from 'react'
import {command} from './core'
import {type NativeEvent, subscribeNative} from './events'

/** Your microphone, or the computer audio (the other participants). */
export type AudioSource = 'mic' | 'system'

/**
 * One sample per source and audio chunk while a recording runs, measured
 * before the two sources are mixed; native throttles it to about 25 a second
 * per source. A muted source sends silence; nothing comes after the recording
 * stops.
 */
export interface RecordingAudioLevels {
    source: AudioSource
    /** RMS of the chunk, linear, 0 to about 1. */
    rms: number
    /** Largest absolute sample of the chunk, linear, 0 to about 1. */
    peak: number
    /** Amplified computer audio went past the sample range since the last sample. */
    limiter_hit: boolean
}

export const RECORDING_AUDIO_LEVELS_EVENT = 'recording-audio-levels' as NativeEvent<RecordingAudioLevels>

/** One monitored device in an `audio-levels` update. */
export interface DeviceAudioLevel {
    device_name: string
    /** `output` is the computer audio, captured by loopback. */
    device_type: 'input' | 'output'
    rms_level: number
    peak_level: number
    is_active: boolean
}

/** The latest level of every monitored device, about 12 times a second. */
export interface AudioLevelUpdate {
    /** Unix time in milliseconds. */
    timestamp: number
    levels: DeviceAudioLevel[]
}

export const AUDIO_LEVELS_EVENT = 'audio-levels' as NativeEvent<AudioLevelUpdate>

/**
 * Starts the device preview: native opens each named device (an empty list
 * means the default microphone and output) and emits `audio-levels` until
 * `stopAudioLevelMonitoring`. A start replaces the preview already running.
 * Screens use `useAudioLevelMonitoring`, which pairs the two.
 */
export function startAudioLevelMonitoring(deviceNames: readonly string[]) {
    return command<null>('start_audio_level_monitoring', {deviceNames})
}

export function stopAudioLevelMonitoring() {
    return command<null>('stop_audio_level_monitoring')
}

// The scale of the old meters (LiveAudioVisualizer at 162e8be), kept so a level
// reads the same as before. Speech on a raw device is often far below 0.05
// linear, so the meter is linear in decibels: -50 dB (a quiet room) is empty
// and -16 dB (close, loud speech) is full, which puts normal speech, about
// -30 dB, a little above the middle.
export const SILENCE_DB = -50
export const FULL_DB = -16
// A sine's peak is √2 (≈1.41) times its RMS. A chunk's peak can fall between
// samples; taking RMS × 1.45 as a floor keeps such a chunk as loud as its energy.
export const RMS_TO_PEAK = 1.45

// The old meters floored the preview gain at 0.05 (-26 dB), so a slider at
// zero still shows a loud device faintly instead of an empty meter.
const MIN_GAIN = 0.05

/**
 * A sample's level on the meter scale, 0 (silence) to 1 (full). `gain` is a
 * device preview's volume slider, applied before the decibels, so the meter
 * shows the level the slider would give; recording samples already carry
 * their gain and take none.
 */
export function levelOf(rms: number, peak: number, gain = 1): number {
    const amplitude = Math.max(peak, rms * RMS_TO_PEAK) * Math.max(MIN_GAIN, gain)
    const db = 20 * Math.log10(Math.max(amplitude, 1e-6))
    return Math.min(1, Math.max(0, (db - SILENCE_DB) / (FULL_DB - SILENCE_DB)))
}

/**
 * Where a ring or a meter takes its level from. Plain data, so a caller can
 * write a new literal on every render.
 *
 * - `recording`: one source of the recording, or `both` (the louder of the
 *   two), as the recording ring shows it.
 * - `device`: the device preview. `device` names the device of `type` to
 *   follow, matched loosely (see `deviceLevel`); without it, or when it is not in
 *   the update, the loudest device of `type` counts. `gain` is the volume
 *   slider beside the meter, so moving it changes the meter at once.
 */
export type LevelFeed =
    | { readonly kind: 'recording'; readonly source: AudioSource | 'both' }
    | {
        readonly kind: 'device'
        readonly type: 'input' | 'output'
        readonly device?: string
        readonly gain?: number
    }

// With `both`, a source counts while its last sample is this recent. Each source
// sends about 25 samples a second; one that has fallen silent for longer (its
// device went away) must not hold the level up.
const FRESH_MS = 250

// A stored device and native's name for it can differ by a suffix: the
// settings keep "JBL Tune 770NC (System Audio) (output)" and the old UI asked
// for it without " (output)". As the old preview did, either name containing
// the other counts as the same device.
const sameDevice = (name: string, wanted: string) =>
    name.length > 0 && (name === wanted || name.includes(wanted) || wanted.includes(name))

/** The level of the device the feed follows in one update; 0 when none is in it. */
function deviceLevel(update: AudioLevelUpdate, feed: Extract<LevelFeed, { kind: 'device' }>): number {
    const {device: wanted, type, gain} = feed
    // Only devices of the feed's type: on Linux an output is named after its
    // card ("X (System Audio)"), which the loose match takes for the input "X".
    const ofType = update.levels.filter((device) => device.device_type === type)
    const named = wanted ? ofType.find((device) => sameDevice(device.device_name, wanted)) : undefined
    const candidates = named ? [named] : ofType
    return Math.max(0, ...candidates.map((device) => levelOf(device.rms_level, device.peak_level, gain)))
}

/**
 * Calls `onLevel` with each new level (0 to 1) of `feed` until the returned
 * function is called. No React: useAudioLevel and the tests call it.
 */
export function subscribeAudioLevel(feed: LevelFeed, onLevel: (level: number) => void): () => void {
    if (feed.kind === 'device') {
        return subscribeNative(AUDIO_LEVELS_EVENT, (update) => onLevel(deviceLevel(update, feed)))
    }
    if (feed.source !== 'both') {
        const source = feed.source
        return subscribeNative(RECORDING_AUDIO_LEVELS_EVENT, (sample) => {
            if (sample.source === source) onLevel(levelOf(sample.rms, sample.peak))
        })
    }
    const latest: Record<AudioSource, { level: number; at: number }> = {
        mic: {level: 0, at: -Infinity},
        system: {level: 0, at: -Infinity},
    }
    return subscribeNative(RECORDING_AUDIO_LEVELS_EVENT, (sample) => {
        const now = performance.now()
        latest[sample.source] = {level: levelOf(sample.rms, sample.peak), at: now}
        const fresh = (source: AudioSource) => (now - latest[source].at <= FRESH_MS ? latest[source].level : 0)
        onLevel(Math.max(fresh('mic'), fresh('system')))
    })
}

/**
 * Calls `onLevel` with each new level of `feed` while mounted; `null`
 * subscribes to nothing. The handler always sees the latest props, and the
 * subscription changes only when the feed does.
 */
export function useAudioLevel(feed: LevelFeed | null, onLevel: (level: number) => void) {
    const notify = useEffectEvent(onLevel)
    // The feed is plain data: its JSON is the dependency, so a new literal with
    // the same fields does not resubscribe.
    const key = feed && JSON.stringify(feed)

    useEffect(() => {
        if (key === null) return
        return subscribeAudioLevel(JSON.parse(key) as LevelFeed, (level) => notify(level))
    }, [key])
}

// Native start_audio_level_monitoring stops the running preview and waits
// before it opens the devices, so a stop that reaches it during that wait is
// undone by the start. Every start and stop therefore waits for the one before.
let previewQueue: Promise<unknown> = Promise.resolve()

function queuePreview(task: () => Promise<unknown>) {
    const next = previewQueue.then(task)
    previewQueue = next.catch((error: unknown) => console.error('Audio level preview failed:', error))
}

/**
 * Runs the device preview while mounted and `deviceNames` is not null, and
 * stops it on unmount, which closes the devices. An empty list previews the
 * default microphone and output. Only one preview runs at a time in the app,
 * so one screen at a time uses this hook.
 */
export function useAudioLevelMonitoring(deviceNames: readonly string[] | null) {
    const key = deviceNames && JSON.stringify(deviceNames)

    useEffect(() => {
        if (key === null) return
        queuePreview(() => startAudioLevelMonitoring(JSON.parse(key) as string[]))
        return () => queuePreview(stopAudioLevelMonitoring)
    }, [key])
}
