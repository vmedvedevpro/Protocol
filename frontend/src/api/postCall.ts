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
 *   which Enhance transcript (#119) and "N speakers (Change)" (#113) call too;
 * - the state of each meeting's pass (`usePostCallJob`). The recording's
 *   runner (features/recording/store/postCallRunner.ts), mounted through
 *   RecordingRuntime by the shell above navigation, is its only writer;
 *   screens read it and ask the runner to cancel, retry or skip a step
 *   through `postCallControls`.
 *
 * When a step ends the runner invalidates the meeting's queries, so a
 * screen that shows the meeting needs nothing more than the hook. The words
 * and the estimate a screen shows live with the components that draw a job
 * (features/meetings/components/processing).
 */
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

/**
 * Mirrors `RetranscriptionProgress`; `progress_percentage` is 0 to 100, in
 * the bands of `RETRANSCRIPTION_BANDS`.
 */
export interface RetranscriptionProgress {
    meeting_id: string
    /** `decoding`, `vad`, `transcribing`, `saving` or `complete`. */
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

/**
 * What native's percent means (retranscription.rs). It is not linear in
 * time: decoding and speech detection take 5 to 25 (from 5 at once, :296
 * and :339), 25 is said before the speech model loads (:389), the chunks
 * take 25 to 80 evenly (:447), and saving goes from 80 to 100 in about a
 * second (:498, :630, :652). Only the chunks' band has a pace that tells
 * the time left.
 */
export const RETRANSCRIPTION_BANDS = {
    /** The first chunk starts here, after the model has loaded. */
    transcribeFrom: 25,
    /** The last chunk ends here; the save after it takes about a second. */
    transcribeTo: 80,
} as const

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
    /** How many of the `num_speakers` label at least one row (#207). */
    speakers_on_lines: number
    /** Rows whose label the run changed; 0 when it ended with the labels the meeting had (#205). */
    changed: number
    /** Rows that carried a label before the run; 0 on a first run over an unlabelled transcript. */
    labelled_before: number
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

/** A percent native reported, and when it arrived (Date.now()). */
export interface PostCallReading {
    percent: number
    at: number
}

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
    /** How far `step` has got, when native says (retranscription does); else null. */
    reading: PostCallReading | null
    /**
     * Where the pace of `step` is measured from: the last reading at the
     * start of the chunks' band (`RETRANSCRIPTION_BANDS`). Native says 25
     * before the model loads and again as the first chunk starts, so the
     * load is left out of the pace. Null before the band.
     */
    paceFrom: PostCallReading | null
    /** Why `step` failed, in native's words. */
    error: string | null
}

interface PostCallStore {
    jobs: Record<string, PostCallJob>
}

const usePostCallStore = create<PostCallStore>(() => ({jobs: {}}))

function patch(meetingId: string, change: (job: PostCallJob) => Partial<PostCallJob>) {
    usePostCallStore.setState(({jobs}) => {
        const job = jobs[meetingId]
        return job ? {jobs: {...jobs, [meetingId]: {...job, ...change(job)}}} : {jobs}
    })
}

/**
 * The runner's writes. Nothing else changes a job: a screen asks the runner
 * through `postCallControls`, so a job never shows a state its native work
 * is not in.
 */
export const postCallJobs = {
    /** A meeting's pass is waiting to start with these steps (at least one). */
    queue(meetingId: string, steps: readonly PostCallStep[]) {
        usePostCallStore.setState(({jobs}) => ({
            jobs: {
                ...jobs,
                [meetingId]: {meetingId, steps, step: steps[0], state: 'queued', reading: null, paceFrom: null, error: null},
            },
        }))
    },
    /** `step` starts. */
    run(meetingId: string, step: PostCallStep) {
        patch(meetingId, () => ({step, state: 'running', reading: null, paceFrom: null, error: null}))
    },
    /** Native says the running step is at `percent` (0 to 100); `at` is for tests and stories. */
    progress(meetingId: string, percent: number, at = Date.now()) {
        const reading = {percent: Math.min(100, Math.max(0, percent)), at}
        patch(meetingId, ({paceFrom}) => {
            const inBand = reading.percent >= RETRANSCRIPTION_BANDS.transcribeFrom
            // Re-anchored while the percent stands still (the model loading),
            // or first seen inside the band (re-attached after a reload).
            const anchor = inBand && (paceFrom === null || paceFrom.percent === reading.percent)
            return {reading, paceFrom: anchor ? reading : paceFrom}
        })
    },
    cancelling(meetingId: string) {
        patch(meetingId, () => ({state: 'cancelling'}))
    },
    fail(meetingId: string, error: string) {
        patch(meetingId, () => ({state: 'failed', error}))
    },
    /** The pass ended (done, cancelled or skipped): the meeting shows as usual again. */
    end(meetingId: string) {
        usePostCallStore.setState(({jobs}) => {
            const {[meetingId]: _ended, ...rest} = jobs
            return {jobs: rest}
        })
    },
    get: (meetingId: string): PostCallJob | null => usePostCallStore.getState().jobs[meetingId] ?? null,
    /** Drops every job: tests and stories, between cases. */
    reset() {
        usePostCallStore.setState({jobs: {}})
    },
}

/** The meeting's pass while one is queued, runs or failed; null otherwise. */
export function usePostCallJob(meetingId: string | null | undefined): PostCallJob | null {
    return usePostCallStore((state) => (meetingId ? state.jobs[meetingId] ?? null : null))
}

/**
 * A pass runs or waits its turn, for the updater's activity report. One that
 * failed and waits for Retry or Skip holds no native work, so it does not
 * keep an update from installing.
 */
export const usePostCallBusy = () =>
    usePostCallStore((state) => Object.values(state.jobs).some((job) => job.state !== 'failed'))

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
    /**
     * An import finished (#206): identify speakers and write the automatic
     * summary, as after a recording. The pass is the runner's, so it goes on
     * when the import sheet closes or another dialog takes its place.
     */
    afterImport: (meetingId: string) => void
    /**
     * Resolves once the meeting's pass holds no native work: at once without
     * a pass or after a failure, else when a cancelled step has ended and
     * native has let go of the model (a retranscription finishes the piece it
     * is on). Deleting waits for it, so nothing writes into a meeting that is gone.
     */
    settled: (meetingId: string) => Promise<void>
}

let controls: PostCallControls | null = null

/** The runner registers itself while mounted; returns the unregister. */
export function registerPostCallControls(next: PostCallControls): () => void {
    controls = next
    return () => {
        if (controls === next) controls = null
    }
}

/**
 * Forwards to the registered runner; does nothing without one, except that an
 * import's pass is then lost and says so: the meeting stays without speakers
 * and without its automatic summary.
 */
export const postCallControls: PostCallControls = {
    cancel: (meetingId) => controls?.cancel(meetingId),
    retry: (meetingId) => controls?.retry(meetingId),
    skip: (meetingId) => controls?.skip(meetingId),
    afterImport: (meetingId) => {
        if (controls) controls.afterImport(meetingId)
        else console.warn(`No post-call runner is registered: imported meeting ${meetingId} gets no speakers or automatic summary.`)
    },
    settled: (meetingId) => controls?.settled(meetingId) ?? Promise.resolve(),
}
