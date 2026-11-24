/**
 * The pass that runs after a recording is saved: the transcript improved
 * from the saved audio (retranscription), speakers found in it
 * (diarization), then the automatic summary. Native code runs each step;
 * the WebView orders them, because the transcript must be replaced before
 * speakers are found in it and both must be done before the summary reads
 * it. The order and its owner are in PARITY.md (Post-call pass order).
 *
 * This file holds two things the meeting screen and Home share with the
 * recording that starts the pass:
 *
 * - the native commands and events of retranscription and diarization,
 *   which Enhance transcript (#119) and "N speakers · change" (#113) call too;
 * - the state of each meeting's pass (`usePostCallJob`). The recording
 *   feature's runner, mounted once by the shell above navigation, is its
 *   only writer; screens read it and ask the runner to cancel, retry or
 *   skip a step through `postCallControls`.
 *
 * When a step ends the runner invalidates the meeting's queries, so a screen
 * that shows the meeting needs nothing more than the hook.
 */
import {useEffect, useState} from 'react'
import {create} from 'zustand'
import {command} from './core'
import type {NativeEvent} from './events'

// ---------------------------------------------------------------------------
// Retranscription (src-tauri/src/audio/retranscription.rs)

export interface RetranscriptionRequest {
    meetingId: string
    /** The meeting's recording folder, which holds its audio. */
    meetingFolderPath: string
    /** A language code, or null to detect it (Parakeet always detects). */
    language: string | null
    model: string | null
    provider: 'parakeet' | 'whisper' | null
    /** Extra words for this run (Enhance transcript, #119); null after a recording. */
    vocabularyTerms?: string | null
    vocabularyScope?: 'meeting' | 'global' | null
}

/** Mirrors `RetranscriptionStarted`. */
export interface RetranscriptionStarted {
    meeting_id: string
    message: string
}

/** Mirrors `RetranscriptionProgress`; `progress_percentage` is 0 to 100. */
export interface RetranscriptionProgress {
    meeting_id: string
    /** `decoding`, `transcribing` or `saving`. */
    stage: string
    progress_percentage: number
    message: string
}

/** The `retranscription-complete` payload. */
export interface RetranscriptionComplete {
    meeting_id: string
    segments_count: number
    duration_seconds: number
    language: string | null
}

/** Mirrors `RetranscriptionError`; `error` is "Retranscription cancelled" after a cancel. */
export interface RetranscriptionError {
    meeting_id: string
    error: string
}

export const RETRANSCRIPTION_PROGRESS_EVENT = 'retranscription-progress' as NativeEvent<RetranscriptionProgress>
export const RETRANSCRIPTION_COMPLETE_EVENT = 'retranscription-complete' as NativeEvent<RetranscriptionComplete>
export const RETRANSCRIPTION_ERROR_EVENT = 'retranscription-error' as NativeEvent<RetranscriptionError>

/**
 * Starts a retranscription and returns once native has spawned it; the
 * result arrives by event, filtered by meeting id. Register the listeners
 * before calling: a short file can finish before the call returns. Native
 * runs one at a time and rejects a second with "Retranscription already in
 * progress".
 */
export function startRetranscription(request: RetranscriptionRequest) {
    return command<RetranscriptionStarted>('start_retranscription_command', {
        meetingId: request.meetingId,
        meetingFolderPath: request.meetingFolderPath,
        language: request.language,
        model: request.model,
        provider: request.provider,
        vocabularyTerms: request.vocabularyTerms ?? null,
        vocabularyScope: request.vocabularyScope ?? null,
    })
}

/**
 * Asks native to stop the meeting's retranscription. It stops between
 * chunks and then emits `retranscription-error`; until that event the job
 * still holds the speech model. Rejects when that meeting has none running.
 */
export const cancelRetranscription = (meetingId: string) =>
    command<null>('cancel_retranscription_command', {meetingId})

/** Whether native is still retranscribing that meeting, to re-attach after a reload. */
export const isRetranscriptionInProgress = (meetingId: string) =>
    command<boolean>('is_retranscription_in_progress_command', {meetingId})

// ---------------------------------------------------------------------------
// Diarization (src-tauri/src/diarization/mod.rs)

/** Mirrors `MeetingDiarizationResult`. */
export interface MeetingDiarizationResult {
    num_speakers: number
    /** Transcript rows that got a speaker label. */
    labeled: number
    /** `[transcript id, "Speaker N"]` pairs. */
    assignments: [string, string][]
}

/**
 * Finds the speakers of a saved meeting from its audio and relabels its
 * transcript rows; text, timestamps and the microphone's "You" stay. A
 * `numSpeakers` of null detects the count; the Nemotron engine always does.
 * Holds the diarization busy reason natively while it runs.
 */
export const diarizeMeeting = (meetingId: string, numSpeakers: number | null = null) =>
    command<MeetingDiarizationResult>('diarize_meeting', {meetingId, numSpeakers})

// ---------------------------------------------------------------------------
// The pass of each meeting

/** The steps after "Recording saved", in the order they run. */
export type PostCallStep = 'transcript' | 'speakers' | 'summary'

export const POST_CALL_STEPS: readonly PostCallStep[] = ['transcript', 'speakers', 'summary']

/**
 * - `queued`: waiting for another meeting's pass (native retranscribes one
 *   meeting at a time).
 * - `running`: `step` runs.
 * - `cancelling`: a cancel was asked; native finishes the chunk it is on.
 * - `failed`: `step` failed with `error`; a screen offers Retry and
 *   Skip (`postCallControls`).
 */
export type PostCallState = 'queued' | 'running' | 'cancelling' | 'failed'

export interface PostCallJob {
    meetingId: string
    /**
     * The steps this meeting runs, in order: a meeting without audio skips
     * `transcript` (its live transcript stays), and one without the
     * automatic summary skips `summary`.
     */
    steps: readonly PostCallStep[]
    /** The step running, being cancelled or failed; the first step while queued. */
    step: PostCallStep
    state: PostCallState
    /** How much of `step` is done, 0 to 100, when native says (retranscription does); else null. */
    percent: number | null
    /** When `step` started (Date.now()), for the time left. */
    stepStartedAt: number
    /** Why `step` failed, in native's words. */
    error: string | null
}

interface PostCallStore {
    jobs: Record<string, PostCallJob>
}

const usePostCallStore = create<PostCallStore>(() => ({jobs: {}}))

function patch(meetingId: string, change: Partial<PostCallJob>) {
    usePostCallStore.setState(({jobs}) => {
        const job = jobs[meetingId]
        return job ? {jobs: {...jobs, [meetingId]: {...job, ...change}}} : {jobs}
    })
}

/**
 * The runner's writes. Nothing else changes a job: a screen asks the runner
 * through `postCallControls`, so a job never shows a state its native work
 * is not in.
 */
export const postCallJobs = {
    /** A meeting's pass is waiting to start with these steps. */
    queue(meetingId: string, steps: readonly PostCallStep[]) {
        const first = steps[0] ?? 'transcript'
        usePostCallStore.setState(({jobs}) => ({
            jobs: {
                ...jobs,
                [meetingId]: {meetingId, steps, step: first, state: 'queued', percent: null, stepStartedAt: Date.now(), error: null},
            },
        }))
    },
    /** `step` starts now, or started at `startedAt` (re-attaching to native work). */
    run(meetingId: string, step: PostCallStep, startedAt = Date.now()) {
        patch(meetingId, {step, state: 'running', percent: null, stepStartedAt: startedAt, error: null})
    },
    /** How far the running step has got, 0 to 100. */
    progress(meetingId: string, percent: number) {
        patch(meetingId, {percent: Math.min(100, Math.max(0, percent))})
    },
    cancelling(meetingId: string) {
        patch(meetingId, {state: 'cancelling'})
    },
    fail(meetingId: string, error: string) {
        patch(meetingId, {state: 'failed', error})
    },
    /** The pass ended (done, cancelled or skipped): the meeting shows as usual again. */
    end(meetingId: string) {
        usePostCallStore.setState(({jobs}) => {
            const {[meetingId]: _ended, ...rest} = jobs
            return {jobs: rest}
        })
    },
    get: (meetingId: string): PostCallJob | null => usePostCallStore.getState().jobs[meetingId] ?? null,
    all: (): PostCallJob[] => Object.values(usePostCallStore.getState().jobs),
    /** Calls `listener` after every change; returns the unsubscribe. */
    subscribe: (listener: () => void) => usePostCallStore.subscribe(listener),
    /** Drops every job: tests and stories, between cases. */
    reset() {
        usePostCallStore.setState({jobs: {}})
    },
}

/** The meeting's pass while one is queued, runs or failed; null otherwise. */
export function usePostCallJob(meetingId: string | null | undefined): PostCallJob | null {
    return usePostCallStore((state) => (meetingId ? state.jobs[meetingId] ?? null : null))
}

/** Whether any meeting's pass is queued, runs or failed. */
export function usePostCallBusy(): boolean {
    return usePostCallStore((state) => Object.keys(state.jobs).length > 0)
}

/** What a screen may ask of the runner. */
export interface PostCallControls {
    /** Stop the pass; the meeting keeps the transcript it has. */
    cancel: (meetingId: string) => void
    /** Run the failed step again, and the steps after it. */
    retry: (meetingId: string) => void
    /**
     * Leave out the failed step and go on with the next one: after a failed
     * `transcript` the live transcript stays, and speakers are found in it.
     */
    skip: (meetingId: string) => void
}

let controls: PostCallControls | null = null

/** The runner registers itself while mounted; returns the unregister. */
export function registerPostCallControls(next: PostCallControls): () => void {
    controls = next
    return () => {
        if (controls === next) controls = null
    }
}

/** Forwards to the registered runner; does nothing without one. */
export const postCallControls: PostCallControls = {
    cancel: (meetingId) => controls?.cancel(meetingId),
    retry: (meetingId) => controls?.retry(meetingId),
    skip: (meetingId) => controls?.skip(meetingId),
}

// ---------------------------------------------------------------------------
// Words and numbers for screens

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
    const current = job.state === 'running' || job.state === 'cancelling' ? (job.percent ?? 0) / 100 : 0
    return (1 + index + current) / total
}

// An estimate from the first percent or seconds swings wildly: a model loads
// before the first chunk, so the early rate understates the rest.
const ESTIMATE_MIN_PERCENT = 5
const ESTIMATE_MIN_MS = 5_000

/**
 * The time left in the running step, in ms, from how fast its percent has
 * climbed so far; null while there is too little to go on, or for a step
 * without a percent.
 */
export function postCallRemainingMs(job: PostCallJob, now: number): number | null {
    if (job.state !== 'running' || job.percent === null) return null
    const elapsed = now - job.stepStartedAt
    if (job.percent < ESTIMATE_MIN_PERCENT || elapsed < ESTIMATE_MIN_MS) return null
    return (elapsed * (100 - job.percent)) / job.percent
}

/** "about 2 min", or "under a minute"; an estimate, so rounded to the nearest minute. */
export function formatRemaining(ms: number): string {
    const minutes = Math.round(ms / 60_000)
    return minutes < 1 ? 'under a minute' : `about ${minutes} min`
}

// The estimate changes with every percent; a tick keeps it moving between
// them, and a few seconds is as fine as "about 2 min" needs.
const ESTIMATE_TICK_MS = 5_000

/** The time left for a job, as words, kept current while it runs; null when unknown. */
export function useRemainingText(job: PostCallJob | null): string | null {
    const [now, setNow] = useState(() => Date.now())
    const running = job?.state === 'running' && job.percent !== null
    useEffect(() => {
        if (!running) return
        const timer = setInterval(() => setNow(Date.now()), ESTIMATE_TICK_MS)
        return () => clearInterval(timer)
    }, [running])
    if (!job) return null
    // A new percent is a fresh reading: measure against the render's time then.
    const remaining = postCallRemainingMs(job, Math.max(now, job.stepStartedAt))
    return remaining === null ? null : formatRemaining(remaining)
}
