/**
 * Advice on the computer audio's level during a recording
 * (docs/SYSTEM_AUDIO_LEVEL_ADVICE.md), which `SourceMeter` shows as its
 * warning state: "Too loud" while the limiter keeps clipping it, "Low audio"
 * while it stays very quiet. Both read native's post-gain samples
 * (`recording-audio-levels`); the microphone gets neither, and nothing here
 * changes the gain or the recording.
 *
 * These are advisory heuristics, not calibrated minimums for speech
 * recognition: quiet background noise can qualify, so the advice says "if
 * someone is speaking".
 */
import {useEffect, useState} from 'react'
import {RECORDING_AUDIO_LEVELS_EVENT} from '@/api/audio'
import {subscribeNative} from '@/api/events'

export type LevelWarning = 'loud' | 'quiet'

const QUIET_RMS = 10 ** (-45 / 20)
const QUIET_PEAK = 10 ** (-30 / 20)
// Below -80 dBFS is digital silence, not a quiet call.
const SIGNAL_FLOOR = 10 ** (-80 / 20)
/** Quiet this long, without a break, says "Low audio". */
export const QUIET_AFTER_MS = 5_000
// A gap longer than this between samples starts the count again.
const QUIET_GAP_MS = 300
/** Without samples this long (silence, a lost device), the low-audio advice goes. */
export const QUIET_EXPIRES_MS = 1_000

/** Counts consecutive quiet samples; one per meter. A missing sample never counts as quiet. */
export class QuietMonitor {
    private since: number | null = null
    private last: number | null = null

    reset() {
        this.since = null
        this.last = null
    }

    /** True once the samples have been quiet for `QUIET_AFTER_MS`. */
    update(rms: number, peak: number, now: number): boolean {
        const quiet = Number.isFinite(rms) && Number.isFinite(peak) && Number.isFinite(now)
            && rms > SIGNAL_FLOOR && peak >= rms && rms < QUIET_RMS && peak < QUIET_PEAK
        if (!quiet) {
            this.reset()
            return false
        }
        if (this.last === null || now < this.last || now - this.last > QUIET_GAP_MS) this.since = now
        this.last = now
        return now - (this.since ?? now) >= QUIET_AFTER_MS
    }
}

/** The limiter clipping this long, with hits no further apart than `LOUD_GAP_MS`, says "Too loud". */
export const LOUD_AFTER_MS = 750
const LOUD_GAP_MS = 250
/** "Too loud" goes this long after the last hit. */
export const LOUD_EXPIRES_MS = 1_500

/** Times the limiter's hits; one per meter. */
export class LoudMonitor {
    private since: number | null = null
    private last: number | null = null

    reset() {
        this.since = null
        this.last = null
    }

    /** A sample with `limiter_hit`: true once the hits have lasted `LOUD_AFTER_MS`. */
    hit(now: number): boolean {
        if (this.last === null || now - this.last > LOUD_GAP_MS) this.since = now
        this.last = now
        return now - (this.since ?? now) >= LOUD_AFTER_MS
    }
}

/**
 * The computer audio's warning while `active` (recording, not paused): Too
 * loud wins over Low audio. Each advice clears on its own timer once its
 * samples stop.
 */
export function useSystemAudioWarning(active: boolean): LevelWarning | null {
    const [loud, setLoud] = useState(false)
    const [quiet, setQuiet] = useState(false)

    useEffect(() => {
        if (!active) return
        const quietMonitor = new QuietMonitor()
        const loudMonitor = new LoudMonitor()
        let quietTimer: ReturnType<typeof setTimeout> | undefined
        let loudTimer: ReturnType<typeof setTimeout> | undefined
        const stop = subscribeNative(RECORDING_AUDIO_LEVELS_EVENT, (sample) => {
            if (sample.source !== 'system') return
            const now = performance.now()
            setQuiet(quietMonitor.update(sample.rms, sample.peak, now))
            clearTimeout(quietTimer)
            quietTimer = setTimeout(() => {
                quietMonitor.reset()
                setQuiet(false)
            }, QUIET_EXPIRES_MS)
            if (!sample.limiter_hit) return
            if (loudMonitor.hit(now)) setLoud(true)
            clearTimeout(loudTimer)
            loudTimer = setTimeout(() => {
                loudMonitor.reset()
                setLoud(false)
            }, LOUD_EXPIRES_MS)
        })
        return () => {
            stop()
            clearTimeout(quietTimer)
            clearTimeout(loudTimer)
            setLoud(false)
            setQuiet(false)
        }
    }, [active])

    return loud ? 'loud' : quiet ? 'quiet' : null
}
