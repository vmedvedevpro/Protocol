/**
 * Stop, and the save native hands over (PARITY.md, Stop and save order,
 * #32). Every Stop (the bar, ⌘R, the tray, the minibar, a quit, a capture
 * failure) ends in native finalization and then `recording-stop-complete`
 * with a `stop_id`; the save below answers it with `recording_save_finished`.
 * A quit waits up to 120 s for that answer.
 */
import {getDatabaseDirectory} from '@/api/app'
import {errorMessage} from '@/api/core'
import {folderKeys, meetingKeys, saveTranscript, setMeetingFolder} from '@/api/meetings'
import {saveMeetingNotes} from '@/api/notes'
import {toast} from '@/components/ui/toastStore'
import {queries} from './queries'
import {
    discardRecordingFolder,
    getTranscriptionStatus,
    recordingSaveFinished,
    type RecordingStopComplete,
    type SaveOutcome,
    stopRecording as stopNative,
} from '../api/recording'
import {deleteRecovery, markRecoverySaved} from '../api/recovery'
import {toSegment} from '../api/transcript'
import {finalTitle} from '../lib/titles'
import {links} from './links'
import {clearLiveNotes, flushLiveNotes} from './liveNotes'
import {startPostCall} from './postCallRunner'
import {applySummaryLanguage} from './summaryLanguage'
import {clockSeconds, finishSession, session} from './session'

/** A take shorter than this is discarded, not saved. */
export const MIN_TAKE_SECONDS = 10

/** How the wait for the last lines is paced (`get_transcription_status`). */
export const SAVE_TIMING = {
    pollMs: 500,
    /** The longest wait; after it nothing is saved and the crash copy stays for recovery. */
    limitMs: 60_000,
    /** The queue is empty and nothing happened this long: the worker is idle, not slow. */
    idleMs: 8_000,
    /** Lines still on their way from the worker after the queue emptied. */
    lateLinesMs: 4_000,
    /** The last events reach the session before it is read. */
    settleMs: 500,
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Stops the recording from this window. The save starts when native has
 * finished stopping (`saveAfterStop`).
 */
export async function stopRecording() {
    const {phase} = session.get()
    if (phase !== 'recording' && phase !== 'paused') return
    finishSession()
    try {
        // Native requires the path but only creates its parent: the audio goes in the meeting's folder.
        const directory = await getDatabaseDirectory()
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await stopNative(`${directory}/recording-${stamp}.wav`)
    } catch (error) {
        // Still recording: say so, and let the user try again. The timer goes on from the take's length.
        session.set({phase, step: null, clock: {seconds: session.get().clock.seconds, at: Date.now()}})
        toast.error('Could not stop the recording', {description: errorMessage(error)})
    }
}

/** Answers native, which a quit is waiting on; resolves true when Protocol quits after the save. */
async function answer(stopId: number | null | undefined, outcome: SaveOutcome): Promise<boolean> {
    if (stopId == null) return false
    try {
        return await recordingSaveFinished(stopId, outcome)
    } catch {
        return false
    }
}

type WaitResult = 'done' | 'timeout' | 'error'

/**
 * Polls until native has transcribed everything it queued: the queue is
 * empty and the worker idle, or idle for `idleMs`. A failed poll ends the
 * wait undone.
 */
async function waitForTranscription(): Promise<WaitResult> {
    const started = Date.now()
    while (Date.now() - started < SAVE_TIMING.limitMs) {
        try {
            const status = await getTranscriptionStatus()
            if (status.chunks_in_queue === 0 && (!status.is_processing || status.last_activity_ms > SAVE_TIMING.idleMs)) {
                return 'done'
            }
            session.set({step: status.chunks_in_queue > 0 ? `Transcribing the last ${status.chunks_in_queue} pieces…` : 'Finishing…'})
        } catch {
            return 'error'
        }
        await wait(SAVE_TIMING.pollMs)
    }
    return 'timeout'
}

let saving = false

/**
 * Offers the notes when they did not reach a meeting. They stay in this
 * window's storage only until the next start, and recovery brings back the
 * transcript, not the notes, so the toast waits until it is used or closed.
 */
function offerNotesCopy(markdown: string | undefined, description: string) {
    if (!markdown?.trim()) return
    toast.warning('Your notes were not saved', {
        id: 'recording-notes',
        description,
        action: {label: 'Copy notes', onClick: () => void navigator.clipboard?.writeText(markdown)},
        duration: Infinity,
    })
}

const NOT_RECOVERED = 'Copy them now: recovering the meeting brings back its transcript, not its notes.'

/**
 * The save after `recording-stop-complete`: discard a short take, wait for
 * the last lines, save the meeting with its folder, notes and summary
 * language, answer native, then open the meeting and start its post-call
 * pass, unless Protocol is quitting.
 */
export async function saveAfterStop(stop: RecordingStopComplete) {
    if (saving) {
        // A second hand-over while one saves has nothing left to save.
        await answer(stop.stop_id, 'notSaved')
        return
    }
    saving = true
    // Stopped from elsewhere (the tray, the minibar, a quit): the timer stops here.
    finishSession()
    const state = session.get()
    let answered = false
    try {
        if (stop.audio_save_error) {
            toast.error('Some or all of the meeting audio could not be saved', {
                description: `The transcript is kept. ${stop.audio_save_error}`,
                duration: 10_000,
            })
        }

        // A window that never saw the start (a failed sync) cannot tell the length, and saves.
        if (state.startedAt !== null && clockSeconds(state) < MIN_TAKE_SECONDS) {
            if (stop.folder_path) await discardRecordingFolder(stop.folder_path).catch(() => undefined)
            if (state.recoveryId) await deleteRecovery(state.recoveryId).catch(() => undefined)
            answered = true
            await answer(stop.stop_id, 'discarded')
            clearLiveNotes()
            session.clear()
            toast('Recording cancelled', {description: `That take was under ${MIN_TAKE_SECONDS} seconds, so nothing was saved.`})
            return
        }

        session.set({step: 'Transcribing the last words…'})
        const waited = await waitForTranscription()
        if (waited !== 'timeout') await wait(SAVE_TIMING.lateLinesMs)
        await wait(SAVE_TIMING.settleMs)

        if (waited !== 'done') {
            // Kept for recovery: the crash copy has every line that arrived.
            answered = true
            await answer(stop.stop_id, 'notSaved')
            const {notes} = session.get()
            session.clear()
            toast.error('The meeting was not saved', {
                description: 'Transcription did not finish in time. Protocol offers to recover it the next time it starts.',
                duration: 10_000,
            })
            offerNotesCopy(notes?.markdown, NOT_RECOVERED)
            return
        }

        session.set({step: 'Saving the meeting…'})
        flushLiveNotes()
        const {lines, title, titleManual, startedAt, folder, notes, recoveryId} = session.get()
        const start = new Date(startedAt ?? Date.now())
        const meetingId = await saveTranscript({
            title: titleManual ? title.trim() : finalTitle(title || stop.meeting_name || '', start, new Date()),
            titleIsManual: titleManual,
            transcripts: lines.map(toSegment),
            folderPath: stop.folder_path ?? null,
            recordingStartedAt: startedAt ? start.toISOString() : null,
        })

        if (folder) {
            await setMeetingFolder(meetingId, folder.id).catch(() =>
                toast.warning(`The meeting was not filed in ${folder.name}`, {description: 'Move it from the meeting’s menu.'}))
        }
        let notesSaved = true
        if (notes?.markdown.trim()) {
            await saveMeetingNotes(meetingId, {markdown: notes.markdown, json: notes.json}).catch(() => {
                notesSaved = false
            })
        }
        await applySummaryLanguage(meetingId, lines.map((line) => line.text))
        if (recoveryId) await markRecoverySaved(recoveryId).catch(() => undefined)

        answered = true
        const quitting = await answer(stop.stop_id, 'saved')
        void Promise.all([
            queries().invalidateQueries({queryKey: meetingKeys.lists()}),
            queries().invalidateQueries({queryKey: folderKeys.all}),
        ])
        if (notesSaved) clearLiveNotes()
        else offerNotesCopy(notes?.markdown, 'Copy them now and paste them into the meeting’s notes.')
        session.clear()
        if (!quitting) {
            links.openMeeting(meetingId)
            startPostCall({meetingId, folderPath: stop.folder_path ?? null, audioSaved: !stop.audio_save_error})
        }
    } catch (error) {
        // Native waits for one answer; a failure after it (opening the meeting) is not answered twice.
        if (!answered) await answer(stop.stop_id, 'failed')
        const {notes} = session.get()
        session.clear()
        toast.error('Could not save the meeting', {
            description: `${errorMessage(error)} Protocol offers to recover it the next time it starts.`,
            duration: 10_000,
        })
        offerNotesCopy(notes?.markdown, NOT_RECOVERED)
    } finally {
        saving = false
    }
}
