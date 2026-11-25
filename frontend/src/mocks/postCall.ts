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
 * The readings a mock retranscription sends, in native's bands
 * (`RETRANSCRIPTION_BANDS`): decoding and speech detection below 25, 25 as
 * the model loads and again as the first chunk starts, the chunks evenly
 * up to 80, then the save.
 */
export const MOCK_RETRANSCRIPTION_READINGS: readonly { stage: string, percent: number }[] = [
    {stage: 'decoding', percent: 5},
    {stage: 'vad', percent: 15},
    {stage: 'transcribing', percent: 25},
    ...Array.from({length: 11}, (_, chunk) => ({stage: 'transcribing', percent: 25 + chunk * 5})),
    {stage: 'saving', percent: 80},
    {stage: 'saving', percent: 90},
    {stage: 'complete', percent: 100},
]

/**
 * Retranscription and diarization as native runs them, faster: a
 * retranscription sends `MOCK_RETRANSCRIPTION_READINGS` one step apart and
 * then completes, or ends with "Retranscription cancelled" after a cancel,
 * one meeting at a time.
 */
export function createMockPostCall() {
    return {
        /** The meeting being retranscribed; native runs one at a time. */
        retranscribing: null as string | null,
        cancelled: false,
        /** One step of the fake work, ms; a test sets 0. */
        stepMs: 300,
        /** What `diarize_meeting` answers besides the count; a test changes it. */
        diarization: {labeled: 12, changed: 12, speakersOnLines: null as number | null},
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
        for (const {stage, percent} of MOCK_RETRANSCRIPTION_READINGS) {
            await wait(run.stepMs)
            if (!owns(meetingId, run)) return
            if (run.cancelled) {
                run.retranscribing = null
                send(RETRANSCRIPTION_ERROR_EVENT, {meeting_id: meetingId, error: 'Retranscription cancelled'})
                return
            }
            send(RETRANSCRIPTION_PROGRESS_EVENT, {meeting_id: meetingId, stage, progress_percentage: percent, message: `${stage} ${percent}%`})
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
        // In native's order (retranscription.rs, cancel_retranscription_command):
        // a meeting id is checked first, even with nothing running.
        cancel_retranscription_command: ({meetingId}: MockArgs) => {
            if (meetingId != null && state.postCall.retranscribing !== meetingId) {
                throw 'This meeting has no active retranscription'
            }
            if (state.postCall.retranscribing === null) throw 'No retranscription in progress'
            state.postCall.cancelled = true
            return null
        },
        is_retranscription_in_progress_command: ({meetingId}: MockArgs) =>
            meetingId == null ? state.postCall.retranscribing !== null : state.postCall.retranscribing === meetingId,
        diarize_meeting: async ({numSpeakers}: MockArgs): Promise<MeetingDiarizationResult> => {
            await wait(state.postCall.stepMs * 4)
            const found = typeof numSpeakers === 'number' ? numSpeakers : 3
            const {labeled, changed, speakersOnLines} = state.postCall.diarization
            return {num_speakers: found, labeled, changed, speakers_on_lines: speakersOnLines ?? found, assignments: []}
        },
    }
}
