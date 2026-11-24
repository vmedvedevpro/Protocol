/**
 * The pass after a recording is saved (PARITY.md, Post-call pass order):
 * retranscription from the saved audio, then speakers found in the new
 * transcript, then the automatic summary. Each step waits for the one
 * before it: the transcript is replaced in one transaction, diarization
 * relabels those rows, and the summary reads the result. Native
 * retranscribes one meeting at a time, so passes queue.
 *
 * The runner is the only writer of `postCallJobs` (src/api/postCall.ts);
 * the shell mounts it above navigation (PostCallRunner), so a pass goes on
 * while the user moves between screens. Screens ask it to cancel, retry or
 * skip through `postCallControls`. After each step the meeting's queries are
 * refetched, so the screen showing it follows.
 */
import {create} from 'zustand'
import {subscribeNative} from '@/api/events'
import {
    cancelSummary,
    diarizationAvailable,
    getSummary,
    isSummaryRunning,
    meetingKeys,
    startSummary,
    SUMMARY_POLL_MS,
} from '@/api/meetings'
import {isBuiltInModelReady} from '@/api/models'
import {
    cancelRetranscription,
    diarizeMeeting,
    isRetranscriptionInProgress,
    postCallJobs,
    type PostCallStep,
    RETRANSCRIPTION_COMPLETE_EVENT,
    RETRANSCRIPTION_ERROR_EVENT,
    RETRANSCRIPTION_PROGRESS_EVENT,
    startRetranscription,
} from '@/api/postCall'
import {recordingPreferencesQuery} from '@/api/devices'
import {getSummaryModelConfig, useAutoSummaryStore, useMeetingLanguageStore} from '@/api/preferences'
import {queries} from './queries'
import {resolvePostCallModel} from '../api/speech'

/** What the save knows about the meeting it hands to the pass. */
export interface PostCallStart {
    meetingId: string
    folderPath: string | null
    /** Native saved the audio without an error. */
    audioSaved: boolean
}

interface Pass {
    meetingId: string
    folderPath: string | null
    steps: PostCallStep[]
    /** Where the pass goes on when its turn comes: the first step, or the one a Retry or Skip chose. */
    resumeFrom: PostCallStep
    /** Aborted by Cancel; a step checks it between native calls. */
    cancel: AbortController
}

/** Whether a pass runs or waits its turn, for the updater's activity report. */
const useRunnerStore = create<{ working: boolean }>(() => ({working: false}))

/**
 * A pass runs or is queued. One that failed and waits for Retry or Skip
 * holds no native work, so it does not keep an update from installing.
 */
export const usePostCallWorking = () => useRunnerStore((state) => state.working)

const passes = new Map<string, Pass>()
/** Meetings waiting for native's one retranscription, in order. */
let queue: string[] = []
let running: string | null = null

function track() {
    useRunnerStore.setState({working: running !== null || queue.length > 0})
}

class Cancelled extends Error {
    constructor() {
        super('Post-call processing cancelled')
    }
}

/** How the runner paces its waits; tests shorten them. */
export const RUNNER_TIMING = {
    /** The old UI's limit: a retranscription past it is cancelled as stuck. */
    retranscriptionLimitMs: 30 * 60 * 1000,
    /** How often a running summary is read again. */
    summaryPollMs: SUMMARY_POLL_MS,
    /** How often a cancelled retranscription is asked whether it let go of the model. */
    releasePollMs: 500,
}

/**
 * Retranscribes and resolves when native says it is complete. The listeners
 * are registered before the start, and filter by meeting: a short file can
 * finish before the call returns.
 */
async function retranscribe(pass: Pass) {
    if (!pass.folderPath) throw new Error('The recording folder is unavailable, so the transcript cannot be improved.')
    const model = await resolvePostCallModel()
    const language = useMeetingLanguageStore.getState().value
    const {meetingId} = pass
    const stops: (() => void)[] = []
    try {
        await new Promise<void>((resolve, reject) => {
            stops.push(subscribeNative(RETRANSCRIPTION_PROGRESS_EVENT, (event) => {
                if (event.meeting_id === meetingId) postCallJobs.progress(meetingId, event.progress_percentage)
            }))
            stops.push(subscribeNative(RETRANSCRIPTION_COMPLETE_EVENT, (event) => {
                if (event.meeting_id === meetingId) resolve()
            }))
            stops.push(subscribeNative(RETRANSCRIPTION_ERROR_EVENT, (event) => {
                if (event.meeting_id !== meetingId) return
                reject(pass.cancel.signal.aborted ? new Cancelled() : new Error(event.error))
            }))
            const cancel = () => void cancelRetranscription(meetingId).catch(() => undefined)
            pass.cancel.signal.addEventListener('abort', cancel, {once: true})
            stops.push(() => pass.cancel.signal.removeEventListener('abort', cancel))
            const limit = setTimeout(() => {
                cancel()
                reject(new Error('Improving the transcript took too long and was stopped.'))
            }, RUNNER_TIMING.retranscriptionLimitMs)
            stops.push(() => clearTimeout(limit))
            // The listeners register asynchronously; the start waits one turn for them.
            setTimeout(() => {
                if (pass.cancel.signal.aborted) return reject(new Cancelled())
                startRetranscription({
                    meetingId,
                    meetingFolderPath: pass.folderPath!,
                    // Parakeet detects the language itself.
                    language: model.provider === 'parakeet' || language === 'auto' ? null : language,
                    model: model.name,
                    provider: model.provider,
                }).catch(reject)
            }, 0)
        })
    } finally {
        stops.forEach((stop) => stop())
    }
    // A cancelled run may still hold the model for a moment; the next pass waits for it.
    while (await isRetranscriptionInProgress(meetingId).catch(() => false)) {
        await new Promise((resolve) => setTimeout(resolve, RUNNER_TIMING.releasePollMs))
    }
}

/** Starts the automatic summary and waits for native to finish writing it. */
async function summarize(pass: Pass) {
    const config = await getSummaryModelConfig()
    if (!config?.provider || !config.model) throw new Error('No summary model is chosen. Pick one in Settings › AI.')
    if (config.provider === 'builtin-ai' && !(await isBuiltInModelReady(config.model).catch(() => false))) {
        throw new Error('The built-in summary model is not downloaded yet.')
    }
    await startSummary({meetingId: pass.meetingId, provider: config.provider, model: config.model})
    const abort = () => void cancelSummary(pass.meetingId).catch(() => undefined)
    pass.cancel.signal.addEventListener('abort', abort, {once: true})
    try {
        for (; ;) {
            await new Promise((resolve) => setTimeout(resolve, RUNNER_TIMING.summaryPollMs))
            if (pass.cancel.signal.aborted) throw new Cancelled()
            const summary = await getSummary(pass.meetingId)
            void queries().invalidateQueries({queryKey: meetingKeys.summary(pass.meetingId)})
            if (isSummaryRunning(summary.status)) continue
            if (summary.status === 'completed') return
            if (summary.status === 'cancelled') throw new Cancelled()
            throw new Error(summary.error || 'The summary could not be written.')
        }
    } finally {
        pass.cancel.signal.removeEventListener('abort', abort)
    }
}

async function runStep(pass: Pass, step: PostCallStep) {
    switch (step) {
        case 'transcript':
            await retranscribe(pass)
            await queries().invalidateQueries({queryKey: meetingKeys.transcripts(pass.meetingId)})
            return
        case 'speakers':
            // The count is detected; "N speakers · change" (#113) runs it again with one.
            await diarizeMeeting(pass.meetingId, null)
            if (pass.cancel.signal.aborted) throw new Cancelled()
            await queries().invalidateQueries({queryKey: meetingKeys.transcripts(pass.meetingId)})
            return
        case 'summary':
            await summarize(pass)
            await queries().invalidateQueries({queryKey: meetingKeys.summary(pass.meetingId)})
            await queries().invalidateQueries({queryKey: meetingKeys.detail(pass.meetingId)})
    }
}

function finish(meetingId: string) {
    passes.delete(meetingId)
    queue = queue.filter((id) => id !== meetingId)
    postCallJobs.end(meetingId)
    if (running === meetingId) running = null
    track()
    void queries().invalidateQueries({queryKey: meetingKeys.lists()})
    next()
}

/** Runs `pass` from `step` to its last step; stops at a failure, which waits for Retry or Skip. */
async function runFrom(pass: Pass, step: PostCallStep) {
    running = pass.meetingId
    track()
    for (const current of pass.steps.slice(pass.steps.indexOf(step))) {
        postCallJobs.run(pass.meetingId, current)
        try {
            await runStep(pass, current)
        } catch (error) {
            if (error instanceof Cancelled || pass.cancel.signal.aborted) return finish(pass.meetingId)
            postCallJobs.fail(pass.meetingId, error instanceof Error ? error.message : String(error))
            // The failed meeting holds no native work: the next pass may run while it waits.
            running = null
            next()
            track()
            return
        }
        if (pass.cancel.signal.aborted) return finish(pass.meetingId)
    }
    finish(pass.meetingId)
}

function next() {
    if (running) return
    const meetingId = queue.shift()
    const pass = meetingId ? passes.get(meetingId) : undefined
    if (pass) void runFrom(pass, pass.resumeFrom)
    track()
}

/** Goes on from `step` now, or queues it behind the pass that runs. */
function resume(pass: Pass, step: PostCallStep) {
    pass.resumeFrom = step
    if (!running) {
        void runFrom(pass, step)
        return
    }
    // Queued again with the steps left, so the screen shows where it goes on.
    postCallJobs.queue(pass.meetingId, pass.steps.slice(pass.steps.indexOf(step)))
    queue.push(pass.meetingId)
    track()
}

/**
 * Queues the pass of a saved meeting: retranscription and speakers when its
 * audio was saved, the summary when the automatic summary is on. A meeting
 * without audio keeps its live transcript.
 */
export async function startPostCall({meetingId, folderPath, audioSaved}: PostCallStart) {
    if (passes.has(meetingId)) return
    const preferences = await queries().fetchQuery(recordingPreferencesQuery).catch(() => null)
    const audio = audioSaved && !!folderPath && preferences?.auto_save !== false
    const speakers = audio && (await diarizationAvailable().catch(() => false))
    const steps: PostCallStep[] = [
        ...(audio ? ['transcript' as const] : []),
        ...(speakers ? ['speakers' as const] : []),
        ...(useAutoSummaryStore.getState().value ? ['summary' as const] : []),
    ]
    if (steps.length === 0) return
    passes.set(meetingId, {meetingId, folderPath, steps, resumeFrom: steps[0], cancel: new AbortController()})
    postCallJobs.queue(meetingId, steps)
    queue.push(meetingId)
    track()
    next()
}

/** What `postCallControls` forwards to while the runner is mounted. */
export const runnerControls = {
    cancel(meetingId: string) {
        const pass = passes.get(meetingId)
        if (!pass) return
        const job = postCallJobs.get(meetingId)
        if (job?.state === 'running') {
            // Native stops between chunks; the step's end finishes the pass.
            postCallJobs.cancelling(meetingId)
            pass.cancel.abort()
        } else {
            pass.cancel.abort()
            finish(meetingId)
        }
    },
    retry(meetingId: string) {
        const pass = passes.get(meetingId)
        const job = postCallJobs.get(meetingId)
        if (!pass || job?.state !== 'failed') return
        resume(pass, job.step)
    },
    skip(meetingId: string) {
        const pass = passes.get(meetingId)
        const job = postCallJobs.get(meetingId)
        if (!pass || job?.state !== 'failed') return
        const after = pass.steps.slice(pass.steps.indexOf(job.step) + 1)
        if (after.length === 0) {
            finish(meetingId)
            return
        }
        // The skipped step leaves the list rather than showing as done.
        pass.steps = pass.steps.filter((step) => step !== job.step)
        postCallJobs.queue(meetingId, pass.steps)
        resume(pass, after[0])
    },
}

/** Drops every pass without touching native: tests, between cases. */
export function resetPostCallRunner() {
    for (const pass of passes.values()) pass.cancel.abort()
    passes.clear()
    queue = []
    running = null
    track()
}
