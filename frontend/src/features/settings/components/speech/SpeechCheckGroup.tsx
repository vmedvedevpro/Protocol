import {type ReactNode, useState} from 'react'
import {CaretDownIcon, WarningCircleIcon} from '@phosphor-icons/react'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {DIARIZATION_DOWNLOAD_CANCELLED, diarizationKeys, diarizationStatusQuery, cancelNemotronDownload, downloadNemotron, NEMOTRON} from '@/api/diarization'
import {cancelIntelDownload, downloadGpuVersion, intelError, isIntelCancelled} from '@/api/intel'
import {trackIntelDownload} from '@/api/modelDownloadSync'
import {useRecordingBusy} from '@/api/recordingPhase'
import {parakeetModelsQuery, whisperModelsQuery} from '@/api/models'
import {postCallConfigQuery, transcriptConfigQuery} from '@/api/speech'
import {
    cancelSpeechCheck,
    CHECK_STEPS,
    type CheckStep,
    type CheckStepKind,
    checkPair,
    dismissSpeechCheck,
    pairAvailabilityQuery,
    pairCompanionQuery,
    resumeSpeechCheck,
    runSpeechCheck,
    saveReport,
    selectedModels,
    type SpeechCheckStatus,
    speechCheckStatusQuery,
    STEP_NAMES,
    STEP_ROLES,
    useSpeechCheckSync,
} from '@/api/speechCheck'
import {Button} from '@/components/ui/Button'
import {Collapse} from '@/components/ui/Collapse'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {StatusLine} from '@/components/ui/StatusLine'
import {toast} from '@/components/ui/toastStore'
import {speechModelLabel} from '@/lib/speechModels'
import {useSpeechModels} from '../../hooks/useSpeechModels'
import {ModelRow} from '../ModelRow'
import {Disclosure, QuietButton, RowControls, RowValue, Warning} from '../styles'
import {deviceWords} from './speechCheckText'

const Report = styled.pre`
    max-height: 320px;
    margin: ${({theme}) => theme.space[2]} 0 0;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
    overflow: auto;
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.raised};
    font-family: ${({theme}) => theme.fonts.mono};
    ${({theme}) => theme.text.caption};
    white-space: pre-wrap;
    overflow-wrap: anywhere;
`

// The failed value: Settings' warning tone with the sign a failed step has
// in a meeting's processing steps, on one line like the other values.
const Failure = styled(Warning)`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    white-space: nowrap;

    > svg {
        flex: none;
    }
`

/** The head row's label in every state; its line says the state, its control holds the main action. */
const HEAD = 'Check the speech models'

const ABOUT = 'Runs each speech model on a short sample and writes a report to send to the developers. Takes a few minutes.'

/** Parts as sentences: one stands alone, as the rows' single facts do; more end with a period, as the neighbours' do. */
const sentences = (parts: string[]) => (parts.length > 1 ? `${parts.join('. ')}.` : parts[0])

/** "On the Intel GPU, passed", "Failed", "Not checked". */
function stepValue(step: CheckStep): string {
    const on = step.ranOn ? `On the ${deviceWords(step.ranOn)}, ` : ''
    switch (step.status) {
        case 'passed':
            return `${on}passed`
        case 'failed':
            return on ? `${on}failed` : 'Failed'
        case 'notChecked':
            return 'Not checked'
        case 'cancelled':
            return 'Cancelled'
        case 'closedTheApp':
            return 'Protocol closed here'
    }
}

/**
 * Under a step's name: a fallback it took, why it was not checked, and a
 * failure's reason in Settings' warning tone, as a failed download's is.
 */
function stepDescription(step: CheckStep): ReactNode {
    const notes: string[] = []
    if (step.fallback) notes.push(`Fell back from the ${deviceWords(step.fallback.from)} to the ${deviceWords(step.fallback.to)}`)
    if ((step.status === 'notChecked' || step.status === 'closedTheApp') && step.reason) notes.push(step.reason)
    if (step.keepsUp === false) notes.push('Too slow to keep up with a meeting')
    const failure = step.status === 'failed' ? step.reason : undefined
    if (!failure) return notes.length ? sentences(notes) : undefined
    if (!notes.length) return <Warning as="span">{failure}</Warning>
    return <><Warning as="span">{`${failure}.`}</Warning> {`${notes.join('. ')}.`}</>
}

function StepRows({steps}: {steps: CheckStep[]}) {
    return steps.map((step) => (
        <SettingsRow
            key={step.kind}
            label={STEP_NAMES[step.kind]}
            description={stepDescription(step)}
            control={step.status === 'failed' ? <Failure as="span"><WarningCircleIcon size={14} aria-hidden/>{stepValue(step)}</Failure> : <RowValue>{stepValue(step)}</RowValue>}
        />
    ))
}

const OUTCOME_LINES = {
    passed: 'Every model ran without errors',
    failed: 'A model did not pass',
    cancelled: 'The check was cancelled',
    interrupted: 'Protocol closed during the check',
    nothingChecked: 'No model was checked: none of them is on this computer',
} as const

/** The report's row: Copy and Save at hand, the text behind Show report. */
function ReportRow({text, onCopy, onSave}: {text: string, onCopy: () => void, onSave: () => void}) {
    const [shown, setShown] = useState(false)
    return (
        <SettingsRow
            label="Report"
            description="Text, then the same data as JSON"
            control={(
                <RowControls>
                    <Button size="sm" onClick={onCopy}>Copy report</Button>
                    <Button size="sm" onClick={onSave}>Save report</Button>
                </RowControls>
            )}
        >
            <div>
                <Disclosure type="button" aria-expanded={shown} onClick={() => setShown(!shown)}>
                    {shown ? 'Hide report' : 'Show report'}
                    <CaretDownIcon size={11} aria-hidden/>
                </Disclosure>
                <Collapse open={shown}>
                    <Report aria-label="Speech check report" tabIndex={0}>{text}</Report>
                </Collapse>
            </div>
        </SettingsRow>
    )
}

/** The finished report: one row per model, then the report with Copy and Save. */
function Results({status, onAgain}: {status: Extract<SpeechCheckStatus, {state: 'finished' | 'interrupted'}>, onAgain: () => void}) {
    const [resuming, setResuming] = useState(false)
    const locked = useRecordingBusy()
    const copy = () => navigator.clipboard.writeText(status.text).then(
        () => toast.success('Report copied'),
        (error: unknown) => toast.error('Couldn’t copy the report', {description: errorMessage(error)}),
    )
    const save = () => saveReport(status.text).then(
        (saved) => saved && toast.success('Report saved'),
        (error: unknown) => toast.error('Couldn’t save the report', {description: errorMessage(error)}),
    )
    const resume = () => {
        setResuming(true)
        void resumeSpeechCheck()
            .catch((error) => toast.error('The check didn’t start', {description: errorMessage(error)}))
            .finally(() => setResuming(false))
    }
    const interrupted = status.state === 'interrupted'
    // A resumed check keeps the step that closed the app, and says so first.
    const closedIn = interrupted ? status.closedIn : status.report.steps.find((step) => step.status === 'closedTheApp')?.kind
    const headline = closedIn ? `Protocol closed while checking ${STEP_NAMES[closedIn]}` : OUTCOME_LINES[status.report.outcome]
    const remaining = interrupted ? status.remaining.map((kind) => STEP_NAMES[kind]).join(', ') : ''
    const resumable = interrupted && status.remaining.length > 0
    return (
        <>
            <SettingsRow
                label={HEAD}
                description={<span role="status">{remaining ? sentences([headline, `Still to check: ${remaining}`]) : headline}</span>}
                control={(
                    <RowControls>
                        {resumable && <QuietButton type="button" disabled={locked} onClick={onAgain}>Run again</QuietButton>}
                        {resumable && <Button size="sm" variant="filled" disabled={locked} pending={resuming} onClick={resume}>Check the rest</Button>}
                        {!resumable && <Button size="sm" disabled={locked} onClick={onAgain}>Run again</Button>}
                    </RowControls>
                )}
            />
            <StepRows steps={status.report.steps}/>
            <ReportRow text={status.text} onCopy={() => void copy()} onSave={() => void save()}/>
        </>
    )
}

function Running({status}: {status: Extract<SpeechCheckStatus, {state: 'running'}>}) {
    const step = status.step ? `Checking ${STEP_NAMES[status.step]}` : 'Getting ready'
    return (
        <>
            <SettingsRow
                label={HEAD}
                description={<StatusLine status={{key: status.cancelling ? 'cancelling' : status.step ?? 'ready', text: status.cancelling ? 'Cancelling' : step, busy: true}}/>}
                control={<Button size="sm" disabled={status.cancelling} onClick={() => void cancelSpeechCheck().catch(() => undefined)}>Cancel</Button>}
            />
            <StepRows steps={status.done}/>
            {/* The steps to come, so the run shows its length from the start. */}
            {status.steps.filter((kind) => !status.done.some((step) => step.kind === kind)).map((kind) => (
                <SettingsRow key={kind} label={STEP_NAMES[kind]} control={<RowValue>{kind === status.step ? 'Checking' : 'Waiting'}</RowValue>}/>
            ))}
        </>
    )
}

/**
 * Before the check starts: what it will run, a download for each model that
 * is not here (its size from the catalog), Start and Back. A model left
 * undownloaded is reported as not checked.
 */
function Offer({onBack, onStarted}: {onBack: () => void, onStarted: () => void}) {
    const queryClient = useQueryClient()
    const locked = useRecordingBusy()
    const [starting, setStarting] = useState(false)
    const {parakeet, whisper, gpuVersion, downloads, download, cancel} = useSpeechModels()
    const availabilityResult = useQuery(pairAvailabilityQuery)
    const companionResult = useQuery(pairCompanionQuery)
    const speakers = useQuery(diarizationStatusQuery)
    const parakeetList = useQuery(parakeetModelsQuery)
    const whisperList = useQuery(whisperModelsQuery)
    const live = useQuery(transcriptConfigQuery).data
    const postCall = useQuery(postCallConfigQuery).data
    const availability = availabilityResult.data
    const companion = companionResult.data
    // The pair and what is installed follow from all of these: until each has
    // loaded, a row could say Ready for a model that is not the one checked,
    // and one that failed would leave the pair unknown.
    const loading = [availabilityResult, companionResult, speakers, parakeetList, whisperList].some((query) => query.isPending)
    const unreadable = speakers.isError || parakeetList.isError || whisperList.isError
        ? 'Protocol couldn’t read its speech models'
        : availabilityResult.isError || companionResult.isError
            ? 'Protocol couldn’t tell which Whisper suits this computer'
            : null

    const pair = checkPair(availability, companion)
    const parakeetModel = parakeet.find(({name}) => name === pair.live)
    const usesGpuVersion = !!companion && pair.postMeeting === companion.id
    const copy = whisper.find(({name}) => name === pair.postMeeting)
    const installed: Record<CheckStepKind, boolean> = {
        parakeet: parakeetModel?.status === 'Available',
        whisper: usesGpuVersion ? !!companion?.installed : copy?.status === 'Available',
        pyannote: !!speakers.data?.pyannote_available,
        nemotron: !!speakers.data?.nemotron_available,
    }
    const downloading = Object.values(downloads).some((state) => state.state === 'downloading')
    const ready = !loading && !unreadable && (!!parakeetModel || !!copy || usesGpuVersion)

    const start = () => {
        setStarting(true)
        void runSpeechCheck({liveModel: pair.live, postMeetingModel: pair.postMeeting, ...selectedModels(live, postCall)})
            .then(onStarted)
            .catch((error) => toast.error('The check didn’t start', {description: errorMessage(error)}))
            .finally(() => setStarting(false))
    }

    const getGpuVersion = () => {
        if (!companion) return
        void trackIntelDownload(queryClient, 'intelGpu', companion.id, () => downloadGpuVersion(companion.id, {choose: false}))
            .catch((error) => {
                if (!isIntelCancelled(error)) toast.error('The download didn’t finish', {description: intelError(error)})
            })
    }
    const getNemotron = () => {
        void downloadNemotron()
            .catch((error) => {
                if (errorMessage(error) !== DIARIZATION_DOWNLOAD_CANCELLED) toast.error('Nemotron didn’t install', {description: errorMessage(error)})
            })
            .finally(() => void queryClient.invalidateQueries({queryKey: diarizationKeys.all}))
    }

    const missingNote = 'Not checked unless downloaded'
    const notChecked = (kind: CheckStepKind, description: string) => (
        <SettingsRow key={kind} label={STEP_NAMES[kind]} description={description} control={<RowValue>Not checked</RowValue>}/>
    )
    // What each step runs when it is here, and its row when it is not: a
    // download where the catalog has one, else why it will not be checked.
    const readyNames: Record<CheckStepKind, string> = {
        parakeet: parakeetModel ? speechModelLabel('parakeet', parakeetModel) : pair.live,
        whisper: usesGpuVersion && gpuVersion ? speechModelLabel('whisper', gpuVersion) : copy ? speechModelLabel('whisper', copy) : pair.postMeeting,
        pyannote: 'built in',
        nemotron: 'downloaded',
    }
    const missingRows: Record<CheckStepKind, ReactNode> = {
        parakeet: parakeetModel
            ? (
                <ModelRow
                    key="parakeet"
                    name={STEP_NAMES.parakeet}
                    engine="parakeet"
                    model={parakeetModel}
                    description={sentences([STEP_ROLES.parakeet, missingNote])}
                    downloads={downloads}
                    onDownload={() => download(parakeetModel)}
                    onCancel={() => cancel(parakeetModel)}
                />
            )
            : notChecked('parakeet', sentences([STEP_ROLES.parakeet, `Protocol has no ${pair.live}`])),
        whisper: usesGpuVersion && companion
            ? (
                <ModelRow
                    key="whisper"
                    name="Whisper for the Intel GPU"
                    engine="intelGpu"
                    model={{name: companion.id, status: 'Missing', size_bytes: companion.downloadSize}}
                    description={sentences([STEP_ROLES.whisper, missingNote])}
                    downloads={downloads}
                    onDownload={getGpuVersion}
                    onCancel={() => void cancelIntelDownload(companion.id).catch(() => undefined)}
                />
            )
            : copy
                ? (
                    <ModelRow
                        key="whisper"
                        name={speechModelLabel('whisper', copy)}
                        engine="whisper"
                        model={copy}
                        description={sentences([STEP_ROLES.whisper, missingNote])}
                        downloads={downloads}
                        onDownload={() => download(copy)}
                        onCancel={() => cancel(copy)}
                    />
                )
                : notChecked('whisper', sentences([STEP_ROLES.whisper, `Protocol has no ${pair.postMeeting}`])),
        pyannote: notChecked('pyannote', 'Its files are missing from this copy of Protocol'),
        nemotron: (
            <ModelRow
                key="nemotron"
                name={STEP_NAMES.nemotron}
                engine="nemotron"
                model={{name: NEMOTRON, status: 'Missing', size_bytes: speakers.data?.nemotron_download_size}}
                description={sentences([STEP_ROLES.nemotron, missingNote])}
                downloads={downloads}
                onDownload={getNemotron}
                onCancel={() => void cancelNemotronDownload().catch(() => undefined)}
            />
        ),
    }
    const modelRows = CHECK_STEPS.map((kind) => installed[kind]
        ? <SettingsRow key={kind} label={STEP_NAMES[kind]} description={`${STEP_ROLES[kind]}, ${readyNames[kind]}`} control={<RowValue>Ready</RowValue>}/>
        : missingRows[kind])

    return (
        <>
            <SettingsRow
                label={HEAD}
                description="Runs these models, each on the device Protocol picks for this computer. Changes no settings."
                control={(
                    <RowControls>
                        <QuietButton type="button" onClick={onBack}>Back</QuietButton>
                        <Button size="sm" variant="filled" disabled={!ready || downloading || locked} pending={starting} onClick={start}>Start check</Button>
                    </RowControls>
                )}
            />
            {locked && <SettingsRow label="During a recording" description="The check can run once the recording is saved"/>}
            {loading && <SettingsRow label="Models" description={<StatusLine status={{key: 'loading', text: 'Looking for the models on this computer', busy: true}}/>}/>}
            {!loading && !unreadable && modelRows}
            {!loading && unreadable && <SettingsRow label="Models" description={<Warning as="span" role="alert">{unreadable}</Warning>}/>}
        </>
    )
}

/**
 * Settings › Advanced › Speech check (#233): idle, offering downloads,
 * running with Cancel, and the report when it ends (passed, failed,
 * cancelled, or after Protocol closed during a step, with the remaining
 * steps to run). Native owns the run; the group follows its status.
 */
export function SpeechCheckGroup() {
    useSpeechCheckSync()
    const status = useQuery(speechCheckStatusQuery).data
    const [offering, setOffering] = useState(false)
    const locked = useRecordingBusy()

    const again = () => {
        void dismissSpeechCheck().catch(() => undefined)
        setOffering(true)
    }

    let body
    if (status?.state === 'running') {
        body = <Running status={status}/>
    } else if (status?.state === 'finished' || status?.state === 'interrupted') {
        body = <Results status={status} onAgain={again}/>
    } else if (offering) {
        body = <Offer onBack={() => setOffering(false)} onStarted={() => setOffering(false)}/>
    } else {
        body = (
            <SettingsRow
                label={HEAD}
                description={locked ? 'Can’t run during a recording' : ABOUT}
                control={<Button size="sm" disabled={!status || locked} onClick={() => setOffering(true)}>Run check</Button>}
            />
        )
    }
    return <SettingsGroup title="Speech check">{body}</SettingsGroup>
}
