/**
 * Record: the one start sequence, from the bar, ⌘R and the tray (PARITY.md,
 * Recording start order). The speech runtime is checked and the live model
 * loaded first, so a start that cannot record says why before capture
 * opens; then the title, then capture. The recording counts as started on
 * native's `recording-started` (runtime.ts), not on this call's answer.
 */
import {recordingPreferencesQuery} from '@/api/devices'
import {meetingsQuery} from '@/api/meetings'
import {toast} from '@/components/ui/toastStore'
import {queries} from './queries'
import {startRecording as startNative} from '../api/recording'
import {describeStartError, prepareSpeech, runtimeMessage, type SpeechProblem} from '../api/speech'
import {automaticTitle} from '../lib/titles'
import {beginSession} from './begin'
import {links} from './links'
import {clearLiveNotes} from './liveNotes'
import {session} from './session'

const speechModelsAction = () => ({label: 'Speech models', onClick: () => links.openSpeechModels()})

function reportSpeechProblem(problem: SpeechProblem) {
    switch (problem.kind) {
        case 'runtime':
            toast.error('Speech recognition unavailable', {description: problem.message, id: 'recording-start'})
            return
        case 'integrity':
            toast.error('The speech model needs downloading again', {
                description: problem.message,
                action: speechModelsAction(),
                id: 'recording-start',
            })
            return
        case 'downloading':
            toast.info('The speech model is still downloading', {
                description: 'Recording can start once it has finished.',
                id: 'recording-start',
            })
            return
        case 'missing':
            toast.error('No speech model yet', {
                description: 'Download a speech model to record.',
                action: speechModelsAction(),
                id: 'recording-start',
            })
    }
}

/**
 * Starts a recording; resolves true once native has accepted it. Does
 * nothing while one starts, runs or is being saved.
 */
export async function startRecording(): Promise<boolean> {
    const {phase, folder} = session.get()
    if (phase !== 'idle') return false
    // Loading a large model takes seconds, so the wait says so from the start.
    session.set({phase: 'starting', step: 'Preparing the speech model…'})
    links.openRecording()

    try {
        const problem = await prepareSpeech()
        if (problem) {
            reportSpeechProblem(problem)
            session.set({phase: 'idle', step: null})
            return false
        }

        const startedAt = Date.now()
        const existing = queries().getQueryData(meetingsQuery.queryKey)?.map((meeting) => meeting.title) ?? []
        const title = automaticTitle(new Date(startedAt), folder?.name, existing)
        clearLiveNotes()
        session.set({step: 'Starting audio capture…', title, titleManual: false, startedAt, lines: []})

        const preferences = await queries().fetchQuery(recordingPreferencesQuery).catch(() => null)
        await startNative(preferences?.preferred_mic_device ?? null, preferences?.preferred_system_device ?? null, title)
        if (session.get().phase === 'starting') await beginSession()
        return true
    } catch (error) {
        // A start that already turned into a recording (its event came first) stays.
        if (session.get().phase === 'starting') session.set({phase: 'idle', step: null, startedAt: null})
        const runtime = runtimeMessage(error)
        if (runtime) {
            toast.error('Speech recognition unavailable', {description: runtime, id: 'recording-start'})
        } else {
            const {title, message} = describeStartError(error)
            toast.error(title, {description: message, duration: 8_000, id: 'recording-start'})
        }
        return false
    }
}
