/**
 * Settings › AI, the speech half: which models transcribe during and after
 * a meeting, the meeting language, Faster live text, the words to
 * recognize, the speaker engine, and the way to Speech models. The models
 * offered are the installed ones; a saved model that is gone stays shown as
 * such, as a device that is not connected does.
 */
import {useMutation, useQuery} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import {errorMessage} from '@/api/core'
import {downloadKey, downloadWhisperModel, POST_CALL_WHISPER_MODEL} from '@/api/models'
import {
    isWhisperProvider,
    postCallConfigQuery,
    savePostCallConfigMutation,
    saveTranscriptConfigMutation,
    transcriptConfigQuery,
} from '@/api/speech'
import {Button} from '@/components/ui/Button'
import {Select} from '@/components/ui/Select'
import {SettingsGroup, SettingsNavRow, SettingsRow} from '@/components/ui/SettingsRow'
import {Switch} from '@/components/ui/Switch'
import {toast} from '@/components/ui/toastStore'
import {paths} from '@/lib/paths'
import {parseSpeechModel, type SpeechEngine, speechModelChoices, withSavedModel} from '@/lib/speechModels'
import {useRecordingPreferences} from '../../hooks/useRecordingPreferences'
import {useSpeechModels} from '../../hooks/useSpeechModels'
import {MeetingLanguageRow} from '../PreferenceRows'
import {RowControls, Warning} from '../styles'
import {SpeakersGroup} from './SpeakersGroup'
import {VocabularyGroup} from './VocabularyGroup'

const SAME_AS_LIVE = 'live'

const valueOf = (engine: SpeechEngine, name: string) => `${engine}:${name}`

const failed = (error: unknown) => toast.error('Couldn’t save the model', {description: errorMessage(error)})

function TranscriptionGroup() {
    const navigate = useNavigate()
    const {parakeet, whisper, gpuVersion, downloads} = useSpeechModels()
    const live = useQuery(transcriptConfigQuery)
    const postCall = useQuery(postCallConfigQuery)
    const saveLive = useMutation(saveTranscriptConfigMutation())
    const savePostCall = useMutation(savePostCallConfigMutation())
    const {preferences, save} = useRecordingPreferences()

    // Parakeet first; the Intel GPU version reads apart from the copy it serves (src/lib/speechModels.ts).
    const choices = speechModelChoices(parakeet, [...whisper, ...(gpuVersion ? [gpuVersion] : [])])
    const liveValue = live.data ? valueOf(isWhisperProvider(live.data.provider) ? 'whisper' : 'parakeet', live.data.model) : null
    const postCallValue = postCall.data
        ? (postCall.data.provider === 'live' ? SAME_AS_LIVE : valueOf(postCall.data.provider, postCall.data.model))
        : null

    // Whisper's download finished but native could not save it as the after-meeting model.
    const copy = whisper.find(({name}) => name === POST_CALL_WHISPER_MODEL)
    const activation = downloads[downloadKey('whisper', POST_CALL_WHISPER_MODEL)]
    const notSwitched = copy?.status === 'Available' && activation?.state === 'failed'

    return (
        <SettingsGroup title="Transcription">
            <SettingsRow
                label="During the meeting"
                control={(
                    <Select
                        options={withSavedModel(choices, liveValue)}
                        value={liveValue ?? undefined}
                        placeholder="No model"
                        disabled={!live.data || choices.length === 0}
                        onValueChange={(value) => {
                            const chosen = parseSpeechModel(value)
                            if (chosen) saveLive.mutate({provider: chosen.provider === 'whisper' ? 'localWhisper' : 'parakeet', model: chosen.model}, {onError: failed})
                        }}
                    />
                )}
            >
                {choices.length === 0 && parakeet.length + whisper.length > 0 && (
                    <RowControls>
                        <Warning role="alert">No speech model is downloaded, so recording can’t start</Warning>
                        <Button size="sm" onClick={() => void navigate(paths.settingsPage('speech-models'))}>Speech models</Button>
                    </RowControls>
                )}
            </SettingsRow>
            <SettingsRow
                label="After the meeting"
                control={(
                    <Select
                        options={[{value: SAME_AS_LIVE, label: 'Same as during the meeting'}, ...withSavedModel(choices, postCallValue === SAME_AS_LIVE ? null : postCallValue)]}
                        value={postCallValue ?? undefined}
                        disabled={!postCall.data}
                        onValueChange={(value) => {
                            const chosen = value === SAME_AS_LIVE ? {provider: 'live' as const, model: ''} : parseSpeechModel(value)
                            if (chosen) savePostCall.mutate(chosen, {onError: failed})
                        }}
                    />
                )}
            >
                {notSwitched && (
                    <RowControls>
                        <Warning role="alert">Whisper is downloaded, but it couldn’t be turned on for after meetings</Warning>
                        <Button
                            size="sm"
                            onClick={() => void downloadWhisperModel(POST_CALL_WHISPER_MODEL, {enablePostCall: true}).catch(() => undefined)}
                        >
                            Retry
                        </Button>
                    </RowControls>
                )}
            </SettingsRow>
            <MeetingLanguageRow/>
            <SettingsRow
                label="Faster live text"
                control={(
                    <Switch
                        checked={preferences?.real_time_transcription ?? false}
                        disabled={!preferences}
                        onCheckedChange={(on) => save({real_time_transcription: on})}
                    />
                )}
            />
        </SettingsGroup>
    )
}

/** The AI section's speech groups, before the summary groups (#117's AI half). */
export function TranscriptionGroups() {
    return (
        <>
            <TranscriptionGroup/>
            <VocabularyGroup/>
            <SpeakersGroup/>
        </>
    )
}

/** The way to Speech models, after the summary groups. */
export function SpeechModelsGroup() {
    const navigate = useNavigate()
    const {parakeet, whisper} = useSpeechModels()
    const engines = [
        parakeet.some(({status}) => status === 'Available') && 'Parakeet',
        whisper.some(({status}) => status === 'Available') && 'Whisper',
    ].filter(Boolean).join(', ')
    return (
        <SettingsGroup title="Speech models">
            <SettingsNavRow
                label="Downloaded models"
                value={engines || 'None'}
                onClick={() => void navigate(paths.settingsPage('speech-models'))}
            />
        </SettingsGroup>
    )
}
