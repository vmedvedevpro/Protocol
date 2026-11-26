import {useState} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {DIARIZATION_DOWNLOAD_CANCELLED, diarizationKeys, diarizationStatusQuery, cancelNemotronDownload, downloadNemotron, NEMOTRON} from '@/api/diarization'
import {cancelIntelDownload, companionQuery, downloadGpuVersion, intelError, isIntelCancelled, npuQuery, openVinoAvailabilityQuery} from '@/api/intel'
import {trackIntelDownload} from '@/api/modelDownloadSync'
import {useRecordingBusy} from '@/api/recordingPhase'
import {postCallConfigQuery, transcriptConfigQuery} from '@/api/speech'
import {
    cancelSpeechCheck,
    CHECK_STEPS,
    type CheckStep,
    type CheckStepKind,
    checkPair,
    choiceInputs,
    dismissSpeechCheck,
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
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {StatusLine} from '@/components/ui/StatusLine'
import {toast} from '@/components/ui/toastStore'
import {speechModelLabel} from '@/lib/speechModels'
import {useSpeechModels} from '../../hooks/useSpeechModels'
import {ModelRow} from '../ModelRow'
import {RowControls, RowValue, Warning} from '../styles'
import {deviceWords} from './speechCheckText'

const Report = styled.pre`
    max-height: 240px;
    margin: 0;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
    overflow: auto;
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.raised};
    font-family: ${({theme}) => theme.fonts.mono};
    ${({theme}) => theme.text.small};
    white-space: pre-wrap;
    overflow-wrap: anywhere;
`

// Up to four buttons after a check: they wrap rather than run past the card.
const Actions = styled(RowControls)`
    flex: 1 1 auto;
    flex-wrap: wrap;
`

const ABOUT = 'Runs each speech model on a short sample and writes a report to send to the developers. Takes a few minutes'

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

/** Why a step failed or was not checked, and a fallback it took. */
function stepDescription(step: CheckStep): string | undefined {
    const parts: string[] = []
    if (step.fallback) parts.push(`Fell back from the ${deviceWords(step.fallback.from)} to the ${deviceWords(step.fallback.to)}`)
    if (step.status === 'failed' || step.status === 'notChecked' || step.status === 'closedTheApp') {
        if (step.reason) parts.push(step.reason)
    }
    if (step.keepsUp === false) parts.push('Too slow to keep up with a meeting')
    return parts.length ? parts.join('. ') : undefined
}

function StepRows({steps}: {steps: CheckStep[]}) {
    return steps.map((step) => (
        <SettingsRow
            key={step.kind}
            label={STEP_NAMES[step.kind]}
            description={stepDescription(step)}
            control={<RowValue $strong={step.status === 'failed'}>{stepValue(step)}</RowValue>}
        />
    ))
}

const OUTCOME_LINES = {
    passed: 'Every model ran without errors',
    failed: 'A model did not pass',
    cancelled: 'The check was cancelled',
    interrupted: 'Protocol closed during the check',
} as const

/** The finished report: one row per model, the text, Copy and Save. */
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
    return (
        <>
            <SettingsRow
                label="Speech check"
                description={interrupted && remaining ? `${headline}. Still to check: ${remaining}` : headline}
            >
                <Actions>
                    <Button size="sm" onClick={() => void copy()}>Copy report</Button>
                    <Button size="sm" onClick={() => void save()}>Save report</Button>
                    {interrupted && status.remaining.length > 0 && (
                        <Button size="sm" variant="filled" disabled={locked} pending={resuming} onClick={resume}>Run the remaining steps</Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={locked} onClick={onAgain}>Run again</Button>
                </Actions>
            </SettingsRow>
            <StepRows steps={status.report.steps}/>
            <SettingsRow label="Report">
                <Report aria-label="Speech check report" tabIndex={0}>{status.text}</Report>
            </SettingsRow>
        </>
    )
}

function Running({status}: {status: Extract<SpeechCheckStatus, {state: 'running'}>}) {
    const step = status.step ? `Checking ${STEP_NAMES[status.step]}` : 'Getting ready'
    return (
        <>
            <SettingsRow
                label="Speech check"
                description={<StatusLine status={{key: status.cancelling ? 'cancelling' : status.step ?? 'ready', text: status.cancelling ? 'Cancelling' : step, busy: true}}/>}
                control={<Button size="sm" disabled={status.cancelling} onClick={() => void cancelSpeechCheck().catch(() => undefined)}>Cancel</Button>}
            />
            <StepRows steps={status.done}/>
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
    const availability = useQuery(openVinoAvailabilityQuery).data
    const companion = useQuery(companionQuery).data
    const npu = useQuery(npuQuery).data
    const speakers = useQuery(diarizationStatusQuery)
    const live = useQuery(transcriptConfigQuery).data
    const postCall = useQuery(postCallConfigQuery).data

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
    const ready = !!speakers.data && (!!parakeetModel || !!copy || usesGpuVersion)

    const start = () => {
        setStarting(true)
        const declined = CHECK_STEPS.filter((kind) => !installed[kind])
        void runSpeechCheck({
            liveModel: pair.live,
            postMeetingModel: pair.postMeeting,
            ...selectedModels(live, postCall),
            declined,
            choiceInputs: choiceInputs(availability, companion, npu),
        })
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

    const readyRow = (kind: CheckStepKind, name: string) => (
        <SettingsRow key={kind} label={STEP_NAMES[kind]} description={`${STEP_ROLES[kind]}, ${name}`} control={<RowValue>Ready</RowValue>}/>
    )
    const missingNote = 'Not checked unless downloaded'

    return (
        <>
            <SettingsRow label="Speech check" description="It runs these models, each on the device Protocol picks for this computer. It changes no settings">
                <Actions>
                    <Button size="sm" variant="filled" disabled={!ready || downloading || locked} pending={starting} onClick={start}>Start check</Button>
                    <Button size="sm" variant="ghost" onClick={onBack}>Back</Button>
                </Actions>
            </SettingsRow>
            {locked && <SettingsRow label="During a recording" description="The check can run once the recording is saved"/>}
            {installed.parakeet || !parakeetModel
                ? readyRow('parakeet', parakeetModel ? speechModelLabel('parakeet', parakeetModel) : pair.live)
                : (
                    <ModelRow
                        name={STEP_NAMES.parakeet}
                        engine="parakeet"
                        model={parakeetModel}
                        description={`${STEP_ROLES.parakeet}. ${missingNote}`}
                        downloads={downloads}
                        onDownload={() => download(parakeetModel)}
                        onCancel={() => cancel(parakeetModel)}
                    />
                )}
            {installed.whisper
                ? readyRow('whisper', usesGpuVersion && gpuVersion ? speechModelLabel('whisper', gpuVersion) : copy ? speechModelLabel('whisper', copy) : pair.postMeeting)
                : usesGpuVersion && companion
                    ? (
                        <ModelRow
                            name="Whisper for the Intel GPU"
                            engine="intelGpu"
                            model={{name: companion.id, status: 'Missing', size_bytes: companion.downloadSize}}
                            description={`${STEP_ROLES.whisper}. ${missingNote}`}
                            downloads={downloads}
                            onDownload={getGpuVersion}
                            onCancel={() => void cancelIntelDownload(companion.id).catch(() => undefined)}
                        />
                    )
                    : copy && (
                        <ModelRow
                            name={speechModelLabel('whisper', copy)}
                            engine="whisper"
                            model={copy}
                            description={`${STEP_ROLES.whisper}. ${missingNote}`}
                            downloads={downloads}
                            onDownload={() => download(copy)}
                            onCancel={() => cancel(copy)}
                        />
                    )}
            {installed.pyannote
                ? readyRow('pyannote', 'built in')
                : <SettingsRow label={STEP_NAMES.pyannote} description="Its files are missing from this copy of Protocol" control={<RowValue>Not checked</RowValue>}/>}
            {installed.nemotron
                ? readyRow('nemotron', 'downloaded')
                : (
                    <ModelRow
                        name={STEP_NAMES.nemotron}
                        engine="nemotron"
                        model={{name: NEMOTRON, status: 'Missing', size_bytes: speakers.data?.nemotron_download_size}}
                        description={`${STEP_ROLES.nemotron}. ${missingNote}`}
                        downloads={downloads}
                        onDownload={getNemotron}
                        onCancel={() => void cancelNemotronDownload().catch(() => undefined)}
                    />
                )}
            {!ready && speakers.isError && <SettingsRow label="Speech check" description={<Warning role="alert">Protocol couldn’t read its speech models</Warning>}/>}
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
                label="Speech check"
                description={locked ? 'Can’t run during a recording' : ABOUT}
                control={<Button size="sm" disabled={!status || locked} onClick={() => setOffering(true)}>Run check</Button>}
            />
        )
    }
    return <SettingsGroup title="Speech check">{body}</SettingsGroup>
}
