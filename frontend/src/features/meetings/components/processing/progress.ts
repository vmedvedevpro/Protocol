/**
 * What a screen says about a meeting's post-call pass: the words for its
 * steps, how far the whole pass has got, and the time left in the running
 * step. Plain functions over `PostCallJob`, plus the hook that keeps the time
 * left moving between native's readings.
 */
import {useEffect, useState} from 'react'
import {type PostCallJob, type PostCallStep, RETRANSCRIPTION_BANDS} from '@/api/postCall'

const RUNNING: Record<PostCallStep, string> = {
    transcript: 'Improving the transcript',
    speakers: 'Finding speakers',
    summary: 'Writing the summary',
}

const FAILED: Record<PostCallStep, string> = {
    transcript: 'Could not improve the transcript',
    speakers: 'Could not find speakers',
    summary: 'Could not write the summary',
}

const SKIP: Record<PostCallStep, string> = {
    transcript: 'Keep live transcript',
    speakers: 'Skip speakers',
    summary: 'Skip summary',
}

/** The step's name in a list of steps: "Improving the transcript". */
export const postCallStepLabel = (step: PostCallStep) => RUNNING[step]

/** What Skip does after `step` failed: "Keep live transcript". */
export const postCallSkipLabel = (step: PostCallStep) => SKIP[step]

/** One line for the job: what runs, waits or failed. */
export function postCallStatusText(job: PostCallJob): string {
    switch (job.state) {
        case 'queued':
            return 'Waiting for another meeting to finish'
        case 'cancelling':
            return 'Stopping…'
        case 'failed':
            return FAILED[job.step]
        case 'running':
            return RUNNING[job.step]
    }
}

/**
 * The share of the whole pass done, 0 to 1, counting "Recording saved" as
 * its first step: the steps behind the current one, plus the current one's
 * percent when native reports it.
 */
export function postCallProgress(job: PostCallJob): number {
    const total = job.steps.length + 1
    const index = Math.max(0, job.steps.indexOf(job.step))
    const running = job.state === 'running' || job.state === 'cancelling'
    const current = running ? (job.reading?.percent ?? 0) / 100 : 0
    return (1 + index + current) / total
}

// One chunk's time swings with how much speech it holds; a pace over a few
// seconds of chunks is steady enough for "about 2 min".
const ESTIMATE_MIN_MS = 5_000

/**
 * The time left in the running step, in ms: the chunks' pace since
 * `paceFrom`, carried on to the end of the chunks' band, less the time since
 * the last reading. Null before the band (decoding, speech detection, the
 * model loading), after it (the save takes about a second), for a step
 * without a percent, and until the pace has a few seconds behind it.
 */
export function postCallRemainingMs(job: PostCallJob, now: number): number | null {
    const {reading, paceFrom} = job
    if (job.state !== 'running' || !reading || !paceFrom) return null
    if (reading.percent >= RETRANSCRIPTION_BANDS.transcribeTo) return null
    const done = reading.percent - paceFrom.percent
    const spent = reading.at - paceFrom.at
    if (done <= 0 || spent < ESTIMATE_MIN_MS) return null
    const left = (spent * (RETRANSCRIPTION_BANDS.transcribeTo - reading.percent)) / done
    return Math.max(0, left - (now - reading.at))
}

/** "about 2 min", or "under a minute"; an estimate, so rounded to the nearest minute. */
export function formatRemaining(ms: number): string {
    const minutes = Math.round(ms / 60_000)
    return minutes < 1 ? 'under a minute' : `about ${minutes} min`
}

// The time left counts down between readings; a few seconds is as fine as
// "about 2 min" needs.
const ESTIMATE_TICK_MS = 5_000

/** The time left for a job, as words, kept current while it runs; null when unknown. */
export function useRemainingText(job: PostCallJob | null): string | null {
    const [now, setNow] = useState(() => Date.now())
    const counting = job?.state === 'running' && job.paceFrom !== null
    useEffect(() => {
        if (!counting) return
        const timer = setInterval(() => setNow(Date.now()), ESTIMATE_TICK_MS)
        return () => clearInterval(timer)
    }, [counting])
    if (!job) return null
    // A reading newer than the last 5 s tick counts from its own arrival.
    const remaining = postCallRemainingMs(job, Math.max(now, job.reading?.at ?? now))
    return remaining === null ? null : formatRemaining(remaining)
}
