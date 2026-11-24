import {useEffect, useState} from 'react'
import {useQueryClient} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import {useNativeEvent} from '@/api/events'
import {registerPostCallControls} from '@/api/postCall'
import {paths} from '@/lib/paths'
import {setUiActivity, UI_ACTIVITY_RENEW_MS, type UiActivity} from '../api/activity'
import {
    AUDIO_ROUTE_WARNING_EVENT,
    LIVE_DIARIZATION_ERROR_EVENT,
    MICROPHONE_MUTE_CHANGED_EVENT,
    RECORDING_ERROR_EVENT,
    RECORDING_PAUSED_EVENT,
    RECORDING_RESUMED_EVENT,
    RECORDING_STARTED_EVENT,
    RECORDING_STOP_COMPLETE_EVENT,
    RECORDING_STOPPED_EVENT,
    SYSTEM_AUDIO_MUTE_CHANGED_EVENT,
    TRANSCRIPTION_ERROR_EVENT,
    TRANSCRIPTION_WARNING_EVENT,
} from '../api/recording'
import {TRANSCRIPT_UPDATE_EVENT} from '../api/transcript'
import {registerLinks} from '../store/links'
import {flushLiveNotes} from '../store/liveNotes'
import {runnerControls, usePostCallWorking} from '../store/postCallRunner'
import {
    onAudioRouteWarning,
    onLiveDiarizationError,
    onMuteChanged,
    onPauseChanged,
    onRecordingError,
    onRecordingStarted,
    onRecordingStopped,
    onTranscriptionError,
    onTranscriptionWarning,
    onTranscriptUpdate,
    syncWithNative,
} from '../store/runtime'
import {registerQueryClient} from '../store/queries'
import {saveAfterStop} from '../store/save'
import {useSessionStore} from '../store/session'
import {RecoverySheet} from './RecoverySheet'

/**
 * Reports the WebView's own work to the updater while it lasts: the save
 * after Stop, and post-call passes. Renewed within native's lease; `[]` when
 * it ends.
 */
function useUiActivityReport() {
    const finishing = useSessionStore((state) => state.phase === 'finishing')
    const postCall = usePostCallWorking()
    const activities: UiActivity[] = [...(finishing ? ['recordingSave' as const] : []), ...(postCall ? ['postCall' as const] : [])]
    const key = activities.join(',')

    useEffect(() => {
        const list = key ? (key.split(',') as UiActivity[]) : []
        const send = () => void setUiActivity(list).catch(() => undefined)
        send()
        if (list.length === 0) return
        const renew = setInterval(send, UI_ACTIVITY_RENEW_MS)
        return () => clearInterval(renew)
    }, [key])
}

/**
 * The recording's link to native, mounted once by the main window's shell
 * above its routes, so every screen hears the events, and a Stop from the
 * tray, the minibar or a quit is saved whatever screen is open. It joins a
 * recording that runs across a reload, runs post-call passes, and offers
 * interrupted meetings once per session (RecoverySheet).
 */
export function RecordingRuntime() {
    const navigate = useNavigate()
    const [synced, setSynced] = useState(false)
    useEffect(() => {
        registerLinks({
            openRecording: () => void navigate(paths.recording),
            openMeeting: (meetingId) => void navigate(paths.meeting(meetingId)),
            openSpeechModels: () => void navigate(paths.settings('transcription')),
        })
    }, [navigate])

    const client = useQueryClient()
    useEffect(() => registerQueryClient(client), [client])

    useEffect(() => registerPostCallControls(runnerControls), [])

    // The notes' copy is written before the window can go away mid-recording.
    useEffect(() => {
        const flush = () => flushLiveNotes()
        window.addEventListener('pagehide', flush)
        document.addEventListener('visibilitychange', flush)
        return () => {
            window.removeEventListener('pagehide', flush)
            document.removeEventListener('visibilitychange', flush)
        }
    }, [])

    useEffect(() => {
        void syncWithNative().finally(() => setSynced(true))
    }, [])

    useNativeEvent(RECORDING_STARTED_EVENT, () => void onRecordingStarted())
    useNativeEvent(RECORDING_STOPPED_EVENT, onRecordingStopped)
    useNativeEvent(RECORDING_PAUSED_EVENT, () => void onPauseChanged(true))
    useNativeEvent(RECORDING_RESUMED_EVENT, () => void onPauseChanged(false))
    useNativeEvent(RECORDING_STOP_COMPLETE_EVENT, (stop) => void saveAfterStop(stop))
    useNativeEvent(RECORDING_ERROR_EVENT, onRecordingError)
    useNativeEvent(MICROPHONE_MUTE_CHANGED_EVENT, (change) => onMuteChanged('mic', change))
    useNativeEvent(SYSTEM_AUDIO_MUTE_CHANGED_EVENT, (change) => onMuteChanged('system', change))
    useNativeEvent(TRANSCRIPT_UPDATE_EVENT, onTranscriptUpdate)
    useNativeEvent(AUDIO_ROUTE_WARNING_EVENT, onAudioRouteWarning)
    useNativeEvent(LIVE_DIARIZATION_ERROR_EVENT, onLiveDiarizationError)
    useNativeEvent(TRANSCRIPTION_ERROR_EVENT, onTranscriptionError)
    useNativeEvent(TRANSCRIPTION_WARNING_EVENT, onTranscriptionWarning)

    useUiActivityReport()

    // Offered once the sync has said whether this window joins a recording,
    // whose own crash copy is then left out.
    return synced ? <RecoverySheet/> : null
}
