/**
 * The Speech check (#233): Settings › Advanced runs every speech engine on a
 * short known sample, each on the device Protocol picks here, and gets a
 * report a tester pastes into a chat. Native owns the run
 * (src-tauri/src/speech_check/, docs/SPEECH_CHECK.md): it outlives the
 * WebView, keeps the updater waiting, writes a crash note before each step
 * and reports its whole status with `speech-check-changed`.
 *
 * The WebView decides the pair, with the rule of Settings' For this
 * computer card (`gpuOffered`): Parakeet v3 live, and after meetings the
 * Intel GPU version where it is offered, else the Compressed copy. The types
 * mirror `Plan`, `Status` and `report.rs` in native.
 */
import {queryOptions} from '@tanstack/react-query'
import {writeFile} from '@tauri-apps/plugin-fs'
import {command} from './core'
import {type NativeEvent, useEventQuerySync} from './events'
import {type CompanionStatus, gpuOffered, type OpenVinoAvailability, type ParakeetNpuStatus} from './intel'
import {PARAKEET_MODEL, POST_CALL_WHISPER_MODEL} from './models'
import {isWhisperProvider, type PostCallTranscriptConfig, type TranscriptConfig} from './speech'

export type CheckStepKind = 'parakeet' | 'whisper' | 'pyannote' | 'nemotron'

export const CHECK_STEPS: readonly CheckStepKind[] = ['parakeet', 'whisper', 'pyannote', 'nemotron']

export type CheckStepStatus = 'passed' | 'failed' | 'notChecked' | 'cancelled' | 'closedTheApp'

export interface CheckDevice {
    name: string
    why: string
}

export interface CheckClip {
    clip: string
    audioMs: number
    processingMs: number
    realTimeFactor: number
    text?: string
    language?: string
    wordErrorRate?: number
    speakers?: {speakers: number, voices: number, share: number, coverage: number}
    passed: boolean
}

export interface CheckStep {
    kind: CheckStepKind
    status: CheckStepStatus
    reason?: string
    model?: {id: string, version?: string}
    picked?: CheckDevice
    inputs: [string, string][]
    ranOn?: string
    fallback?: {from: string, to: string, error: string}
    loadMs?: number
    clips: CheckClip[]
    keepsUp?: boolean
}

export type CheckOutcome = 'passed' | 'failed' | 'cancelled' | 'interrupted' | 'nothingChecked'

export interface CheckReport {
    format: number
    created: string
    outcome: CheckOutcome
    steps: CheckStep[]
    warnings: string[]
}

export type SpeechCheckStatus =
    | {state: 'idle'}
    | {state: 'running', step: CheckStepKind | null, steps: CheckStepKind[], done: CheckStep[], cancelling: boolean}
    | {state: 'finished', report: CheckReport, text: string}
    | {state: 'interrupted', closedIn: CheckStepKind | null, remaining: CheckStepKind[], report: CheckReport, text: string}

export interface CheckPlan {
    liveModel: string
    postMeetingModel: string
    selectedLive: string | null
    selectedPostMeeting: string | null
    /** Steps whose model the tester did not download. */
    declined: CheckStepKind[]
    /** The inputs of the pair's choice, for the report. */
    choiceInputs: [string, string][]
}

/** The steps' names in the group and the report. */
export const STEP_NAMES: Record<CheckStepKind, string> = {
    parakeet: 'Parakeet',
    whisper: 'Whisper',
    pyannote: 'Pyannote',
    nemotron: 'NVIDIA Nemotron',
}

/** What each step is for, which its name cannot say. */
export const STEP_ROLES: Record<CheckStepKind, string> = {
    parakeet: 'Live text',
    whisper: 'Transcript after the meeting',
    pyannote: 'Speakers',
    nemotron: 'Speakers',
}

// --- Commands --------------------------------------------------------------

export const getSpeechCheckStatus = () => command<SpeechCheckStatus>('speech_check_status')

/** Starts the check; native refuses during a recording or a transcript. */
export const runSpeechCheck = (plan: CheckPlan) => command<null>('speech_check_run', {plan})

/** Runs the steps a check Protocol closed during did not finish. */
export const resumeSpeechCheck = () => command<null>('speech_check_resume')

export const cancelSpeechCheck = () => command<null>('speech_check_cancel')

/** Puts the report away, and an interrupted check's note. */
export const dismissSpeechCheck = () => command<null>('speech_check_dismiss')

export const SPEECH_CHECK_CHANGED_EVENT = 'speech-check-changed' as NativeEvent<SpeechCheckStatus>

export const speechCheckKeys = {
    status: () => ['speechCheck', 'status'] as const,
}

export const speechCheckStatusQuery = queryOptions({
    queryKey: speechCheckKeys.status(),
    queryFn: getSpeechCheckStatus,
    staleTime: Infinity,
})

/** Keeps the status from native's event; mounted by the group. */
export const useSpeechCheckSync = () => useEventQuerySync(SPEECH_CHECK_CHANGED_EVENT, speechCheckStatusQuery.queryKey)

// --- The pair --------------------------------------------------------------

/**
 * The pair the check runs, by the card's rule: the Intel GPU version where
 * it is offered (installed or not), else the Compressed copy.
 */
export function checkPair(availability: OpenVinoAvailability | null | undefined, companion: CompanionStatus | null | undefined) {
    return {live: PARAKEET_MODEL, postMeeting: gpuOffered(availability, companion) ? companion.id : POST_CALL_WHISPER_MODEL}
}

/** The inputs of that choice, named for the report. */
export function choiceInputs(
    availability: OpenVinoAvailability | null | undefined,
    companion: CompanionStatus | null | undefined,
    npu: ParakeetNpuStatus | null | undefined,
): [string, string][] {
    const inputs: [string, string][] = [
        ['Intel GPU version offered', availability?.offer ? 'yes' : 'no'],
        ['Intel GPU version', !companion ? 'none in this build' : companion.refused ? `refused: ${companion.refused}` : companion.installed ? 'installed' : 'not installed'],
        ['Intel NPU', npu?.present ? npu.state : 'none'],
    ]
    if (availability?.reason) inputs.push(['Intel GPU version not offered because', availability.reason])
    return inputs
}

/** A saved model as `engine:model`; the after-meeting model that follows the live one says so. */
export function selectedModels(live: TranscriptConfig | null | undefined, postCall: PostCallTranscriptConfig | undefined) {
    const liveValue = live ? `${isWhisperProvider(live.provider) ? 'whisper' : 'parakeet'}:${live.model}` : null
    const postValue = !postCall ? null : postCall.provider === 'live' ? (liveValue && `same as live (${liveValue})`) : `${postCall.provider}:${postCall.model}`
    return {selectedLive: liveValue, selectedPostMeeting: postValue}
}

// --- Saving ----------------------------------------------------------------

/** Asks where to save the report (the dialog plugin's save dialog); null on Cancel. */
export async function chooseReportPath(): Promise<string | null> {
    const ask = (defaultPath: string) => command<string | null>('plugin:dialog|save', {
        options: {defaultPath, filters: [{name: 'Text', extensions: ['txt']}]},
    })
    const chosen = await ask('protocol-speech-check.txt')
    // A GTK dialog returns the name as typed: ask once more with the extension,
    // so its own overwrite prompt covers the name written (as exports do).
    if (!chosen || chosen.toLowerCase().endsWith('.txt')) return chosen
    return ask(`${chosen}.txt`)
}

export async function saveReport(text: string): Promise<boolean> {
    const path = await chooseReportPath()
    if (!path) return false
    await writeFile(path, new TextEncoder().encode(text))
    return true
}
