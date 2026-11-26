/**
 * The pass after a recording is saved (PARITY.md, Post-call pass order):
 * retranscription from the saved audio, then speakers found in the new
 * transcript, then the automatic summary. Each step waits for the one
 * before it: the transcript is replaced in one transaction, diarization
 * relabels those rows, and the summary reads the result. Native
 * retranscribes one meeting at a time, so passes queue.
 *
 * The runner is the only writer of `postCallJobs` (src/api/postCall.ts).
 * RecordingRuntime, which the shell mounts above navigation, registers its
 * controls, so a pass goes on while the user moves between screens. Screens
 * ask it to cancel, retry or skip through `postCallControls`. After each
 * step the meeting's queries are refetched, so the screen showing it follows.
 */
import {errorMessage} from '@/api/core'
import {listenNative} from '@/api/events'
import {summaryCleaner} from '@/api/labs'
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
import {getSummaryModelConfig, type SummaryModelConfig, type SummaryProvider, useAutoSummaryStore, useMeetingLanguageStore} from '@/api/preferences'
import {queries} from './queries'
import {resolvePostCallModel} from '../api/speech'

/** What the save knows about the meeting it hands to the pass. */
export interface PostCallStart {
    meetingId: string
    folderPath: string | null
    /** Native saved the audio without an error. */
    audioSaved: boolean
    /**
     * The transcript is already the after-meeting one: an import transcribed
     * the file (#206), so the pass starts at speakers.
     */
    imported?: boolean
}

interface Pass {
    meetingId: string
    folderPath: string | null
    steps: PostCallStep[]
    /** Where the pass goes on when its turn comes: the first step, or the one a Retry or Skip chose. */
    resumeFrom: PostCallStep
    /** Aborted by Cancel; a step checks it between native calls. */
    cancel: AbortController
    /** Resolved when the pass finishes; `runnerControls.settled` hands it out. */
    finished: Promise<void>
    finish: () => void
}

const passes = new Map<string, Pass>()
/** Meetings waiting for native's one retranscription, in order. */
let queue: string[] = []
let running: string | null = null

class Cancelled extends Error {
    constructor() {
        super('Post-call processing cancelled')
    }
}

/** How the runner paces its waits; tests shorten them. */
export const RUNNER_TIMING = {
    /** The old UI's limit: a retranscription past it is cancelled as stuck. */
    retranscriptionLimitMs: 30 * 60 * 1000,
    /**
     * How long a retranscription that ended may still hold the model. Native
     * looks at a cancel before each piece, and a piece is at most 25 s of
     * audio (post_meeting.rs, `MAX_PIECE_SAMPLES`), which even a slow CPU
     * decodes well inside this; a run still going past it ignores the cancel.
     */
    releaseLimitMs: 2 * 60 * 1000,
    /** How often a cancelled retranscription is asked whether it let go of the model. */
    releasePollMs: 500,
    /**
     * A summary past it is cancelled as stuck: a hung provider or a lost
     * process. Native ends each model request within 15 minutes (the summary
     * engine's `GENERATION_TIMEOUT_SECS`; 5 minutes for a cloud request,
     * llm_client.rs), so this leaves room for a long meeting written in
     * several requests.
     */
    summaryLimitMs: 60 * 60 * 1000,
    /** How often a running summary is read again. */
    summaryPollMs: SUMMARY_POLL_MS,
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits while native still retranscribes `meetingId`; false when it still
 * does after `releaseLimitMs`. Without the limit a run that ignores its
 * cancel would hold this pass, the queue behind it and the updater for good.
 */
async function released(meetingId: string): Promise<boolean> {
    const deadline = Date.now() + RUNNER_TIMING.releaseLimitMs
    while (await isRetranscriptionInProgress(meetingId).catch(() => false)) {
        if (Date.now() >= deadline) return false
        await wait(RUNNER_TIMING.releasePollMs)
    }
    return true
}

/**
 * Retranscribes and resolves when native says it is complete. The listeners
 * are registered before the start (PARITY.md): a short file can finish, and
 * a missing one fail, before the call returns. They filter by meeting.
 */
async function retranscribe(pass: Pass) {
    if (!pass.folderPath) throw new Error('The recording folder is unavailable, so the transcript cannot be improved.')
    const model = await resolvePostCallModel()
    const language = useMeetingLanguageStore.getState().value
    const {meetingId} = pass
    let settle!: { resolve: () => void, reject: (error: Error) => void }
    const done = new Promise<void>((resolve, reject) => {
        settle = {resolve, reject}
    })
    // Awaited below; an end heard before that is no unhandled rejection.
    done.catch(() => undefined)
    const stops = await Promise.all([
        listenNative(RETRANSCRIPTION_PROGRESS_EVENT, (event) => {
            if (event.meeting_id === meetingId) postCallJobs.progress(meetingId, event.progress_percentage)
        }),
        listenNative(RETRANSCRIPTION_COMPLETE_EVENT, (event) => {
            if (event.meeting_id === meetingId) settle.resolve()
        }),
        listenNative(RETRANSCRIPTION_ERROR_EVENT, (event) => {
            if (event.meeting_id === meetingId) settle.reject(pass.cancel.signal.aborted ? new Cancelled() : new Error(event.error))
        }),
    ])
    const cancel = () => void cancelRetranscription(meetingId).catch(() => undefined)
    pass.cancel.signal.addEventListener('abort', cancel, {once: true})
    const limit = setTimeout(() => {
        cancel()
        settle.reject(new Error('Improving the transcript took too long and was stopped.'))
    }, RUNNER_TIMING.retranscriptionLimitMs)
    let ended: { error: unknown } | null = null
    try {
        if (pass.cancel.signal.aborted) throw new Cancelled()
        // Together, so the time limit covers a start that never answers too.
        await Promise.all([
            startRetranscription({
                meetingId,
                meetingFolderPath: pass.folderPath,
                // Parakeet detects the language itself.
                language: model.provider === 'parakeet' || language === 'auto' ? null : language,
                model: model.name,
                provider: model.provider,
            }),
            done,
        ])
    } catch (error) {
        ended = {error}
    } finally {
        stops.forEach((stop) => stop())
        pass.cancel.signal.removeEventListener('abort', cancel)
        clearTimeout(limit)
    }
    // After a cancel, an error or the time limit native may still finish its
    // chunk and hold the model; the next pass, or a Retry, waits for it. Past
    // the limit the step's own error stands, and a step that completed fails,
    // so Retry is offered rather than a pass that starts only to hear
    // "Retranscription already in progress".
    const free = await released(meetingId)
    if (ended) throw ended.error
    if (!free) throw new Error('The speech model is still busy with this meeting. Retry in a minute.')
}

/**
 * Whether the saved summary model can write now, as native state says: a
 * provider and a model are set, and a built-in model is downloaded (a check
 * that fails counts as not). The pass's plan and the summary step both ask
 * it, so a model chosen but missing (a download cut by a quit, or cancelled
 * in Settings) neither runs nor fails on every meeting.
 */
async function usableSummaryModel(config: SummaryModelConfig | null):
    Promise<{ok: true, provider: SummaryProvider, model: string} | {ok: false, reason: string}> {
    if (!config?.provider || !config.model) return {ok: false, reason: 'No summary model is chosen. Pick one in Settings › AI.'}
    if (config.provider === 'builtin-ai' && !(await isBuiltInModelReady(config.model).catch(() => false))) {
        return {ok: false, reason: 'The built-in summary model is not downloaded yet.'}
    }
    return {ok: true, provider: config.provider, model: config.model}
}

/** Starts the automatic summary and waits for native to finish writing it. */
async function summarize(pass: Pass) {
    const usable = await usableSummaryModel(await getSummaryModelConfig())
    if (!usable.ok) throw new Error(usable.reason)
    if (pass.cancel.signal.aborted) throw new Cancelled()
    await startSummary({meetingId: pass.meetingId, provider: usable.provider, model: usable.model, clean: summaryCleaner()})
    const abort = () => void cancelSummary(pass.meetingId).catch(() => undefined)
    pass.cancel.signal.addEventListener('abort', abort, {once: true})
    // A Cancel while the start was on its way aborted before the listener existed.
    if (pass.cancel.signal.aborted) abort()
    const deadline = Date.now() + RUNNER_TIMING.summaryLimitMs
    try {
        for (; ;) {
            await wait(RUNNER_TIMING.summaryPollMs)
            if (pass.cancel.signal.aborted) throw new Cancelled()
            const summary = await getSummary(pass.meetingId)
            void queries().invalidateQueries({queryKey: meetingKeys.summary(pass.meetingId)})
            if (isSummaryRunning(summary.status)) {
                if (Date.now() < deadline) continue
                await cancelSummary(pass.meetingId).catch(() => undefined)
                throw new Error('Writing the summary took too long and was stopped.')
            }
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
            // The count is detected; "N speakers (Change)" (#113) runs it again with one.
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
    passes.get(meetingId)?.finish()
    passes.delete(meetingId)
    queue = queue.filter((id) => id !== meetingId)
    postCallJobs.end(meetingId)
    if (running === meetingId) running = null
    void queries().invalidateQueries({queryKey: meetingKeys.lists()})
    next()
}

/** Runs `pass` from `step` to its last step; stops at a failure, which waits for Retry or Skip. */
async function runFrom(pass: Pass, step: PostCallStep) {
    running = pass.meetingId
    for (const current of pass.steps.slice(pass.steps.indexOf(step))) {
        postCallJobs.run(pass.meetingId, current)
        try {
            await runStep(pass, current)
        } catch (error) {
            if (error instanceof Cancelled || pass.cancel.signal.aborted) return finish(pass.meetingId)
            postCallJobs.fail(pass.meetingId, errorMessage(error))
            // The failed meeting holds no native work: the next pass may run while it waits.
            running = null
            next()
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
}

/**
 * Queues the pass of a saved meeting: retranscription and speakers when its
 * audio was saved, the summary when the automatic summary is on and the
 * summary model can write (`usableSummaryModel`: first launch can leave it
 * for later, or a built-in model can be missing, and then summaries stay off
 * rather than fail on every meeting). A meeting without audio keeps its
 * live transcript. An imported meeting skips the retranscription: native
 * copied its file into the meeting folder and transcribed it already.
 */
export async function startPostCall({meetingId, folderPath, audioSaved, imported = false}: PostCallStart) {
    if (passes.has(meetingId)) return
    const preferences = imported ? null : await queries().fetchQuery(recordingPreferencesQuery).catch(() => null)
    const audio = imported || (audioSaved && !!folderPath && preferences?.auto_save !== false)
    const speakers = audio && (await diarizationAvailable().catch(() => false))
    // A config that cannot be read keeps the step, which then reports why.
    const summary = useAutoSummaryStore.getState().value
        && (await getSummaryModelConfig().then(async (config) => (await usableSummaryModel(config)).ok, () => true))
    const steps: PostCallStep[] = [
        ...(audio && !imported ? ['transcript' as const] : []),
        ...(speakers ? ['speakers' as const] : []),
        ...(summary ? ['summary' as const] : []),
    ]
    if (steps.length === 0) return
    let end!: () => void
    const finished = new Promise<void>((resolve) => {
        end = resolve
    })
    passes.set(meetingId, {meetingId, folderPath, steps, resumeFrom: steps[0], cancel: new AbortController(), finished, finish: end})
    postCallJobs.queue(meetingId, steps)
    queue.push(meetingId)
    next()
}

/** What `postCallControls` forwards to while the runner is mounted. */
export const runnerControls = {
    cancel(meetingId: string) {
        const pass = passes.get(meetingId)
        if (!pass) return
        const job = postCallJobs.get(meetingId)
        // A pass already cancelling still holds native work too: finishing it
        // now would start the next one while native holds the model.
        if (job?.state === 'running' || job?.state === 'cancelling') {
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
    afterImport(meetingId: string) {
        void startPostCall({meetingId, folderPath: null, audioSaved: true, imported: true})
    },
    settled(meetingId: string): Promise<void> {
        const pass = passes.get(meetingId)
        // A failed pass waits for Retry or Skip and holds no native work.
        if (!pass || postCallJobs.get(meetingId)?.state === 'failed') return Promise.resolve()
        return pass.finished
    },
}

/** Drops every pass without touching native: tests, between cases. */
export function resetPostCallRunner() {
    for (const pass of passes.values()) {
        pass.cancel.abort()
        pass.finish()
    }
    passes.clear()
    queue = []
    running = null
}
