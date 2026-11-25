import {type FormEvent, useState} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {useNativeEvent} from '@/api/events'
import {meetingKeys, meetingQuery} from '@/api/meetings'
import {
    cancelRetranscription,
    RETRANSCRIPTION_COMPLETE_EVENT,
    RETRANSCRIPTION_ERROR_EVENT,
    RETRANSCRIPTION_PROGRESS_EVENT,
    type RetranscriptionProgress,
    startRetranscription,
} from '@/api/postCall'
import {useMeetingLanguageStore} from '@/api/preferences'
import {MAX_VOCABULARY_CHARS, vocabularyQuery} from '@/api/speech'
import {Button} from '@/components/ui/Button'
import {ProgressBar} from '@/components/ui/ProgressBar'
import {Select} from '@/components/ui/Select'
import {SettingsGroup, SettingsRadioGroup, SettingsRadioRow, SettingsRow} from '@/components/ui/SettingsRow'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {Spinner} from '@/components/ui/Spinner'
import {TextArea} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'
import {closeDialog, type OpenedDialog, useDialog} from '@/lib/dialogs'
import {DETECT_LANGUAGE, MEETING_LANGUAGES} from '@/lib/languages'
import {paths} from '@/lib/paths'
import {clearMeetingVocabularyMutation} from '../api/vocabulary'
import {parseSpeechModel} from '@/lib/speechModels'
import {useSpeechModels} from '../lib/useSpeechModels'

const FORM_ID = 'enhance-transcript'

const LANGUAGE_OPTIONS = MEETING_LANGUAGES.map(({code, label}) => ({value: code, label}))

type Scope = 'meeting' | 'global'

const SCOPES = [
    {value: 'meeting', label: 'This meeting only'},
    {value: 'global', label: 'This and future meetings', description: 'Adds them to your vocabulary in Settings'},
] as const

/**
 * - `ready`: the choices are being made.
 * - `running`: native retranscribes; `progress` is its last reading.
 * - `cancelling`: Stop was pressed; native stops between chunks.
 * - `failed`: native's reason, with Try again.
 * `seq` ties it to one opening of the sheet: another opening starts ready.
 */
type Phase = { seq: number } & (
    | { step: 'ready' | 'cancelling' }
    | { step: 'running', progress: RetranscriptionProgress | null }
    | { step: 'failed', error: string })

const Form = styled.form`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3]};
`

const Saved = styled.div`
    display: flex;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.surface};
`

const SavedText = styled.div`
    flex: 1;
    min-width: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};

    > strong {
        display: block;
        font-weight: ${({theme}) => theme.fontWeights.medium};
        color: ${({theme}) => theme.colors.text};
    }

    > span {
        display: block;
        overflow-wrap: anywhere;
        white-space: pre-line;
    }
`

const Progress = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[1.5]};
`

const ProgressLine = styled.div`
    display: flex;
    gap: ${({theme}) => theme.space[2]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};

    > span:first-child {
        flex: 1;
        min-width: 0;
    }
`

const Percent = styled.span`
    font-variant-numeric: tabular-nums;
`

const Failure = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    overflow-wrap: anywhere;
`

const Waiting = styled.div`
    display: flex;
    justify-content: center;
    padding: ${({theme}) => theme.space[6]};
`

const FootLink = styled(Button)`
    margin-right: auto;
`

/**
 * Improve the transcript (the meeting menu's Enhance transcript): runs a
 * speech model again on the meeting's audio, with the language, the model
 * and extra words to recognize, kept for this meeting or added to the
 * vocabulary for every meeting. It starts from the after-meeting model.
 * Native code does the work (`start_retranscription_command`, which holds
 * the retranscription busy reason); the sheet shows its progress, cannot be
 * dismissed meanwhile, and Stop asks native to cancel between chunks.
 */
export function EnhanceSheet() {
    const slot = useDialog()
    const request = slot.request?.kind === 'enhance' ? slot.request : null
    const open = slot.open && request !== null
    const navigate = useNavigate()
    const [state, setPhase] = useState<Phase>({seq: 0, step: 'ready'})
    const models = useSpeechModels()
    const seq = request?.seq ?? 0
    const phase: Phase = state.seq === seq ? state : {seq, step: 'ready'}
    const running = phase.step === 'running' || phase.step === 'cancelling'
    const noWhisper = !models.pending && !models.choices.some((choice) => choice.engine === 'whisper')
    const folder = useQuery({...meetingQuery(request?.meetingId ?? ''), enabled: !!request}).data?.folder_path
    const canStart = !!folder && models.choices.length > 0

    const stop = async () => {
        if (!request) return
        setPhase({seq, step: 'cancelling'})
        // Rejects when native has already ended; its event settles the sheet.
        await cancelRetranscription(request.meetingId).catch(() => undefined)
    }

    return (
        <Sheet
            open={open}
            onOpenChange={(next) => !next && !running && closeDialog('enhance')}
            title="Improve the transcript"
            description="Runs the after-meeting model again on this recording."
            footer={(
                <>
                    {noWhisper && !running && (
                        <FootLink
                            variant="ghost"
                            onClick={() => {
                                closeDialog('enhance')
                                void navigate(paths.settings('transcription'))
                            }}
                        >
                            Get Whisper…
                        </FootLink>
                    )}
                    {running ? (
                        <Button variant="ghost" pending={phase.step === 'cancelling'} onClick={() => void stop()}>Stop</Button>
                    ) : (
                        <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    )}
                    <Button variant="filled" type="submit" form={FORM_ID} pending={running} disabled={phase.step === 'ready' && !canStart}>
                        {phase.step === 'failed' ? 'Try again' : 'Start'}
                    </Button>
                </>
            )}
        >
            {request && <EnhanceForm key={request.seq} request={request} phase={phase} onPhase={setPhase}/>}
        </Sheet>
    )
}

interface EnhanceFormProps {
    request: Extract<OpenedDialog, { kind: 'enhance' }>
    phase: Phase
    onPhase: (phase: Phase) => void
}

function EnhanceForm({request, phase, onPhase}: EnhanceFormProps) {
    const {meetingId, seq} = request
    const client = useQueryClient()
    const meeting = useQuery(meetingQuery(meetingId))
    const vocabulary = useQuery(vocabularyQuery(meetingId))
    const clear = useMutation(clearMeetingVocabularyMutation(meetingId))
    const meetingLanguage = useMeetingLanguageStore((state) => state.value)
    const models = useSpeechModels()
    const [language, setLanguage] = useState(meetingLanguage)
    const [chosenModel, setModel] = useState<string>()
    const [terms, setTerms] = useState('')
    const [scope, setScope] = useState<Scope>('meeting')
    const [listening, setListening] = useState(0)
    const model = chosenModel ?? models.initial
    const engine = parseSpeechModel(model)
    const parakeet = engine?.provider === 'parakeet'
    const running = phase.step === 'running' || phase.step === 'cancelling'
    const mine = (id: string) => id === meetingId && running

    const counted = () => setListening((count) => count + 1)
    useNativeEvent(RETRANSCRIPTION_PROGRESS_EVENT, (progress) => {
        if (mine(progress.meeting_id) && phase.step === 'running') onPhase({seq, step: 'running', progress})
    }, {onListening: counted})
    useNativeEvent(RETRANSCRIPTION_COMPLETE_EVENT, (result) => {
        if (!mine(result.meeting_id)) return
        void Promise.all([
            client.invalidateQueries({queryKey: meetingKeys.transcripts(meetingId)}),
            client.invalidateQueries({queryKey: meetingKeys.lists()}),
        ])
        toast.success('Transcript improved', {
            description: `${result.segments_count} ${result.segments_count === 1 ? 'line' : 'lines'} transcribed again.`,
        })
        closeDialog('enhance')
    }, {onListening: counted})
    useNativeEvent(RETRANSCRIPTION_ERROR_EVENT, ({meeting_id: id, error}) => {
        if (!mine(id)) return
        if (phase.step === 'cancelling' || /cancel/i.test(error)) {
            toast.info('Stopped improving the transcript', {description: 'The transcript stays as it was.'})
            closeDialog('enhance')
            onPhase({seq, step: 'ready'})
        } else {
            onPhase({seq, step: 'failed', error})
        }
    }, {onListening: counted})
    // A short recording can end before the start returns, so the listeners
    // come first; they register as the sheet opens.
    const listeners = listening >= 3

    const folder = meeting.data?.folder_path
    const submit = async (event: FormEvent) => {
        event.preventDefault()
        if (phase.step === 'failed') return onPhase({seq, step: 'ready'})
        if (phase.step !== 'ready' || !folder || !engine || !listeners) return
        onPhase({seq, step: 'running', progress: null})
        try {
            await startRetranscription({
                meetingId,
                meetingFolderPath: folder,
                language: parakeet || language === DETECT_LANGUAGE ? null : language,
                model: engine.model,
                provider: engine.provider,
                vocabularyTerms: terms.trim() || null,
                vocabularyScope: scope,
            })
        } catch (error) {
            onPhase({seq, step: 'failed', error: errorMessage(error)})
        }
    }

    if (meeting.isPending || models.pending) {
        return <Waiting aria-busy="true"><Spinner delayed/></Waiting>
    }
    if (phase.step === 'failed') {
        return (
            <Form id={FORM_ID} onSubmit={(event) => void submit(event)}>
                <Failure role="alert">{phase.error}</Failure>
            </Form>
        )
    }
    if (running) {
        const reading = phase.step === 'running' ? phase.progress : null
        const percent = Math.round(reading?.progress_percentage ?? 0)
        return (
            <Form id={FORM_ID} onSubmit={(event) => void submit(event)} aria-busy="true">
                <Progress>
                    <ProgressBar label="Improving the transcript" value={percent}/>
                    <ProgressLine>
                        <span role="status">{phase.step === 'cancelling' ? 'Stopping…' : reading?.message || 'Starting…'}</span>
                        <Percent>{percent}%</Percent>
                    </ProgressLine>
                </Progress>
            </Form>
        )
    }

    const saved = vocabulary.data?.meeting.trim()
    return (
        <Form id={FORM_ID} onSubmit={(event) => void submit(event)}>
            {!folder && <Failure role="alert">This meeting has no recording to transcribe again.</Failure>}
            <SettingsGroup>
                <SettingsRow
                    label="Language"
                    description={parakeet ? 'Parakeet always detects the language' : undefined}
                    control={(
                        <Select
                            options={LANGUAGE_OPTIONS}
                            value={parakeet ? DETECT_LANGUAGE : language}
                            onValueChange={setLanguage}
                            disabled={parakeet}
                        />
                    )}
                />
                <SettingsRow
                    label="Model"
                    description={models.choices.length === 0 ? 'No speech model is downloaded' : undefined}
                    control={(
                        <Select
                            options={models.choices}
                            value={model}
                            onValueChange={setModel}
                            placeholder="None"
                            disabled={models.choices.length === 0}
                        />
                    )}
                />
            </SettingsGroup>
            <TextArea
                label="Words to recognize"
                mono
                rows={3}
                maxLength={MAX_VOCABULARY_CHARS}
                placeholder="Names, products, jargon. One per line"
                value={terms}
                onChange={(event) => setTerms(event.target.value)}
            />
            <SettingsRadioGroup<Scope> title="Use these words for" value={scope} onValueChange={setScope}>
                {SCOPES.map((option) => <SettingsRadioRow key={option.value} {...option}/>)}
            </SettingsRadioGroup>
            {saved && (
                <Saved>
                    <SavedText>
                        <strong>Already kept for this meeting</strong>
                        <span>{saved}</span>
                    </SavedText>
                    <Button
                        size="sm"
                        variant="ghost"
                        pending={clear.isPending}
                        onClick={() => clear.mutate(undefined, {
                            onError: (error) => toast.error('Couldn’t clear the words', {description: error.message}),
                        })}
                    >
                        Clear
                    </Button>
                </Saved>
            )}
        </Form>
    )
}
