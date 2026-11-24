import {useEffect} from 'react'
import {
    POST_CALL_STEPS,
    postCallJobs,
    type PostCallState,
    type PostCallStep,
    registerPostCallControls,
} from '@/api/postCall'

/** The meeting the stories process. */
export const STORY_MEETING = 'story-meeting'

export interface StoryPass {
    state: PostCallState
    step: PostCallStep
    /** The step's percent; unset for a step without one. */
    percent?: number
    /** Leave out the automatic summary. */
    noSummary?: boolean
    /** Leave out the transcript step, as for a meeting saved without audio. */
    noAudio?: boolean
    /** Keep climbing the percent and moving on to the next step, as a real pass does. */
    play?: boolean
}

const STEP_MS = 400
// A transcript step that started a while ago, so the time left shows.
const STARTED_AGO_MS = 40_000

/**
 * Seeds `postCallJobs` with one job for the stories and stands in for the
 * recording's runner: Cancel stops after a moment, Retry runs the step
 * again, Skip goes on with the next one. With `play` the pass moves by
 * itself.
 */
export function useStoryPass({state, step, percent, noSummary, noAudio, play}: StoryPass) {
    useEffect(() => {
        const steps = POST_CALL_STEPS.filter((each) => !(noSummary && each === 'summary') && !(noAudio && each === 'transcript'))
        const first = steps.includes(step) ? step : steps[0]
        postCallJobs.queue(STORY_MEETING, steps)
        if (state !== 'queued') {
            // A still story's step is back-dated, so its time left shows at once.
            postCallJobs.run(STORY_MEETING, first, percent === undefined || play ? Date.now() : Date.now() - STARTED_AGO_MS)
            if (percent !== undefined) postCallJobs.progress(STORY_MEETING, percent)
            if (state === 'cancelling') postCallJobs.cancelling(STORY_MEETING)
            if (state === 'failed') postCallJobs.fail(STORY_MEETING, 'The speech model ran out of memory on chunk 14 of 31.')
        }

        const next = (meetingId: string) => {
            const job = postCallJobs.get(meetingId)
            const at = job ? job.steps.indexOf(job.step) : -1
            if (!job || at + 1 >= job.steps.length) postCallJobs.end(meetingId)
            else postCallJobs.run(meetingId, job.steps[at + 1])
        }
        const unregister = registerPostCallControls({
            cancel: (meetingId) => {
                postCallJobs.cancelling(meetingId)
                setTimeout(() => postCallJobs.end(meetingId), 1_200)
            },
            retry: (meetingId) => {
                const job = postCallJobs.get(meetingId)
                if (job) postCallJobs.run(meetingId, job.step)
            },
            skip: next,
        })

        const timer = play
            ? setInterval(() => {
                const job = postCallJobs.get(STORY_MEETING)
                if (!job || job.state !== 'running') return
                if (job.step === 'transcript' && (job.percent ?? 0) < 100) {
                    postCallJobs.progress(STORY_MEETING, (job.percent ?? 0) + 4)
                } else {
                    next(STORY_MEETING)
                }
            }, STEP_MS)
            : undefined

        return () => {
            clearInterval(timer)
            unregister()
            postCallJobs.reset()
        }
    }, [state, step, percent, noSummary, noAudio, play])
}
