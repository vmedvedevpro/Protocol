import {emit} from '@tauri-apps/api/event'
import type {NativeEvent} from '@/api/events'
import {
    type MeetingDiarizationResult,
    RETRANSCRIPTION_COMPLETE_EVENT,
    RETRANSCRIPTION_ERROR_EVENT,
    RETRANSCRIPTION_PROGRESS_EVENT,
    type RetranscriptionStarted,
} from '@/api/postCall'
import type {MockArgs, MockHandler} from './handlers'
import type {MockState} from './state'

/**
 * Retranscription and diarization as native runs them, faster: a
 * retranscription climbs 10 % a step and then completes, or ends with
 * "Retranscription cancelled" after a cancel, one meeting at a time.
 */
export function createMockPostCall() {
    return {
        /** The meeting being retranscribed; native runs one at a time. */
        retranscribing: null as string | null,
        cancelled: false,
        /** One step of the fake work, ms; a test sets 0. */
        stepMs: 300,
    }
}

function send<T>(event: NativeEvent<T>, payload: T) {
    // After clearMocks() at the end of a test there is no IPC to send to.
    emit(event, payload).catch(() => undefined)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** src-tauri/src/audio/retranscription.rs, diarization/mod.rs */
export function postCallHandlers(state: MockState): Record<string, MockHandler> {
    // A reset between tests or stories gives `state.postCall` a new object,
    // so a run left over from the last one stops at its next step.
    const owns = (meetingId: string, run: MockState['postCall']) =>
        state.postCall === run && run.retranscribing === meetingId

    async function retranscribe(meetingId: string) {
        const run = state.postCall
        for (let percent = 0; percent <= 100; percent += 10) {
            await wait(run.stepMs)
            if (!owns(meetingId, run)) return
            if (run.cancelled) {
                run.retranscribing = null
                send(RETRANSCRIPTION_ERROR_EVENT, {meeting_id: meetingId, error: 'Retranscription cancelled'})
                return
            }
            send(RETRANSCRIPTION_PROGRESS_EVENT, {
                meeting_id: meetingId,
                stage: percent < 10 ? 'decoding' : percent < 100 ? 'transcribing' : 'saving',
                progress_percentage: percent,
                message: `Transcribing ${percent}%`,
            })
        }
        run.retranscribing = null
        send(RETRANSCRIPTION_COMPLETE_EVENT, {meeting_id: meetingId, segments_count: 12, duration_seconds: 2712, language: 'en'})
    }

    return {
        start_retranscription_command: ({meetingId}: MockArgs): RetranscriptionStarted => {
            const id = String(meetingId)
            if (state.postCall.retranscribing !== null) throw 'Retranscription already in progress'
            Object.assign(state.postCall, {retranscribing: id, cancelled: false})
            void retranscribe(id)
            return {meeting_id: id, message: 'Retranscription started'}
        },
        cancel_retranscription_command: ({meetingId}: MockArgs) => {
            if (state.postCall.retranscribing === null) throw 'No retranscription in progress'
            if (meetingId != null && state.postCall.retranscribing !== meetingId) {
                throw 'This meeting has no active retranscription'
            }
            state.postCall.cancelled = true
            return null
        },
        is_retranscription_in_progress_command: ({meetingId}: MockArgs) =>
            meetingId == null ? state.postCall.retranscribing !== null : state.postCall.retranscribing === meetingId,
        diarize_meeting: async ({numSpeakers}: MockArgs): Promise<MeetingDiarizationResult> => {
            await wait(state.postCall.stepMs * 4)
            return {num_speakers: typeof numSpeakers === 'number' ? numSpeakers : 3, labeled: 0, assignments: []}
        },
    }
}
