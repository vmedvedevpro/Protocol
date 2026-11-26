import {emit} from '@tauri-apps/api/event'
import {
    CHECK_STEPS,
    type CheckDevice,
    type CheckPlan,
    type CheckReport,
    type CheckStep,
    SPEECH_CHECK_CHANGED_EVENT,
    type SpeechCheckStatus,
} from '@/api/speechCheck'
import type {MockHandler} from './handlers'

/**
 * src-tauri/src/speech_check/: the status and its event. A run moves one
 * step per tick and ends with a report; `autoFinish: false` keeps it on its
 * first step, so a test can cancel or follow it. A recording refuses the
 * run, as native does.
 */
export interface MockSpeechCheck {
    status: SpeechCheckStatus
    plans: CheckPlan[]
    cancelled: boolean
    autoFinish: boolean
    /** A step that fails in the report. */
    failing: CheckStep['kind'] | null
}

export function createMockSpeechCheck(): MockSpeechCheck {
    return {status: {state: 'idle'}, plans: [], cancelled: false, autoFinish: true, failing: null}
}

const TICK_MS = 40

/** What each step runs here in the mock: this laptop's devices and models, as the ignored native test reported them. */
const MOCK_STEPS: Record<CheckStep['kind'], {model: string, version: string, device: CheckDevice, because: string, inputs: [string, string][], rtf: [number, number]}> = {
    parakeet: {
        model: 'parakeet-tdt-0.6b-v3-int8',
        version: '6d590f77001d',
        device: {kind: 'processor', name: 'processor'},
        because: 'Parakeet runs on the processor here',
        inputs: [['Parakeet on the GPU (Labs)', 'off'], ['Faster live text', 'off']],
        rtf: [0.03, 0.04],
    },
    whisper: {
        model: 'large-v3-turbo-q5_0',
        version: '4af2b29d7e8b',
        device: {kind: 'vulkan', name: 'GPU (Vulkan): Intel(R) Arc(TM) B390 GPU'},
        because: 'the first discrete GPU ggml lists, else its first GPU',
        inputs: [
            ['Whisper build', 'Vulkan'],
            ['whisper.cpp would use', 'GPU (Vulkan): Intel(R) Arc(TM) B390 GPU (the first discrete GPU ggml lists, else its first GPU)'],
            ['Intel GPU version', 'none'],
            ['OpenVINO offered', 'yes'],
            ['OpenVINO GPU', 'Intel(R) Arc(TM) B390 GPU'],
            ['OpenVINO device', 'GPU'],
        ],
        rtf: [0.14, 0.14],
    },
    pyannote: {
        model: 'pyannote segmentation 3.0 + WeSpeaker ResNet34',
        version: 'bundled',
        device: {kind: 'processor', name: 'processor'},
        because: 'Pyannote and WeSpeaker run on ONNX Runtime\'s CPU provider on every platform',
        inputs: [],
        rtf: [0.06, 0.05],
    },
    nemotron: {
        model: 'diar_streaming_sortformer_4spk-v2.1.onnx',
        version: '3a0c8d1e9f42',
        device: {kind: 'processor', name: 'processor'},
        because: 'Nemotron runs on ONNX Runtime\'s CPU provider outside Windows',
        inputs: [],
        rtf: [0.3, 0.27],
    },
}

const CLIPS = [
    {clip: 'ru', audioMs: 22_600, text: 'Отношения между Китаем и Индией стали напряжёнными, после чего обе страны усилили войска на границе'},
    {clip: 'en', audioMs: 24_600, text: 'The find also grants insight into the evolution of feathers in birds, and it shows how the plumage looked'},
]

const TITLES: Record<CheckStep['kind'], string> = {
    parakeet: 'Parakeet (live text)',
    whisper: 'Whisper (after the meeting)',
    pyannote: 'Pyannote and WeSpeaker (speakers)',
    nemotron: 'Nemotron (speakers)',
}

export function mockStep(kind: CheckStep['kind'], status: CheckStep['status'] = 'passed'): CheckStep {
    const facts = MOCK_STEPS[kind]
    const ran = status === 'passed' || status === 'failed'
    const speakers = kind === 'pyannote' || kind === 'nemotron'
    return {
        kind,
        status,
        reason: status === 'failed' ? 'The en clip came out with 92% of its words wrong (at most 50% pass)'
            : status === 'notChecked' ? 'The model is not downloaded'
                : status === 'cancelled' ? 'Cancelled' : undefined,
        model: {id: facts.model, version: facts.version},
        picked: facts.device,
        pickedBecause: facts.because,
        inputs: facts.inputs,
        ranOn: status === 'notChecked' ? undefined : facts.device,
        loadMs: ran ? (kind === 'whisper' ? 2_840 : 610) : undefined,
        clips: !ran ? [] : CLIPS.map((clip, index) => {
            const failing = status === 'failed' && clip.clip === 'en'
            const realTimeFactor = facts.rtf[index]
            return {
                clip: clip.clip,
                audioMs: clip.audioMs,
                processingMs: clip.audioMs * realTimeFactor,
                realTimeFactor,
                ...(speakers
                    ? {speakers: {speakers: 2, voices: 2, share: 1, coverage: 0.82 - index * 0.01}}
                    : {text: failing ? 'the the the the the the' : clip.text, language: kind === 'whisper' ? clip.clip : undefined, wordErrorRate: failing ? 0.92 : 0}),
                passed: !failing,
            }
        }),
        keepsUp: kind === 'parakeet' && ran ? true : undefined,
    }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/** A step as native's `step_lines` writes it. */
function stepText(step: CheckStep): string[] {
    const lines = [``, `${TITLES[step.kind]}: ${{passed: 'PASS', failed: 'FAIL', notChecked: 'NOT CHECKED', cancelled: 'CANCELLED', closedTheApp: 'CLOSED THE APP'}[step.status]}`]
    if (step.reason) lines.push(`  Reason: ${step.reason}`)
    if (step.model) lines.push(`  Model: ${step.model.id}${step.model.version ? ` (${step.model.version})` : ''}`)
    if (step.picked) lines.push(`  Picked: ${step.picked.name}${step.pickedBecause ? ` (${step.pickedBecause})` : ''}`)
    for (const [name, value] of step.inputs) lines.push(`    ${name}: ${value}`)
    if (step.ranOn) lines.push(`  Ran on: ${step.ranOn.name}`)
    if (step.loadMs !== undefined) lines.push(`  Load: ${seconds(step.loadMs)}`)
    for (const clip of step.clips) {
        const scored = clip.wordErrorRate !== undefined ? `, word errors ${clip.wordErrorRate.toFixed(3)}` : ''
        const language = clip.language ? `, language ${clip.language}` : ''
        const speakers = clip.speakers
            ? `, ${clip.speakers.speakers} speakers for ${clip.speakers.voices} voices, ${Math.round(clip.speakers.share * 100)}% of the labelled speech to the right voice, ${Math.round(clip.speakers.coverage * 100)}% of the turns labelled`
            : ''
        lines.push(`  ${clip.clip}: ${seconds(clip.processingMs)} for ${seconds(clip.audioMs)} (real-time factor ${clip.realTimeFactor.toFixed(2)})${scored}${language}${speakers}, ${clip.passed ? 'pass' : 'fail'}`)
        if (clip.text) lines.push(`    Text: ${clip.text}`)
    }
    if (step.keepsUp !== undefined) lines.push(`  Keeps up with a meeting: ${step.keepsUp ? 'yes' : 'no'}`)
    return lines
}

const OUTCOME_WORDS: Record<CheckReport['outcome'], string> = {
    passed: 'passed',
    failed: 'failed',
    cancelled: 'cancelled',
    interrupted: 'interrupted: Protocol closed during a step',
    nothingChecked: 'nothing was checked',
}

/** The report and its text, laid out as native's `Report::render` writes it. */
export function mockReport(steps: CheckStep[], outcome: CheckReport['outcome']): {report: CheckReport, text: string} {
    const created = '2026-11-26T10:00:00Z'
    const warnings = steps.filter((step) => step.status === 'failed' && step.reason).map((step) => `${TITLES[step.kind]}: ${step.reason}`)
    const report: CheckReport = {format: 1, created, outcome, steps, warnings}
    const text = [
        `Protocol speech check: ${OUTCOME_WORDS[outcome]}`,
        `Created ${created}`,
        '',
        'Protocol 1.0.0-rc.2 (deb), Whisper built for Vulkan',
        'OS: linux 26.10, Kubuntu 26.10, KDE, wayland',
        'Processor: Intel(R) Core(TM) Ultra X7 358H (16 threads, AVX2 yes, AVX-512 no), RAM 30.9 GB',
        'GPU: PCI 8086:b080 at 0000:00:02.0 (Intel), driver xe',
        'Vulkan devices (ggml): Vulkan0: Intel(R) Arc(TM) B390 GPU',
        'Intel OpenCL driver: present',
        'ONNX Runtime: 1.22.0 (ort 2.0.0-rc.10), providers CPU',
        '',
        'Checked pair: live parakeet:parakeet-tdt-0.6b-v3-int8, after the meeting whisper:large-v3-turbo-q5_0',
        ...steps.flatMap(stepText),
        ...(warnings.length ? ['', 'Warnings:', ...warnings.map((warning) => `  ${warning}`)] : []),
        '',
        'JSON:',
        JSON.stringify(report, null, 2),
    ].join('\n')
    return {report, text}
}

export function speechCheckHandlers(state: {speechCheck: MockSpeechCheck, live: {recording: unknown}, diarization: {nemotronInstalled: boolean}}): Record<string, MockHandler> {
    const publish = (status: SpeechCheckStatus) => {
        state.speechCheck.status = status
        void emit(SPEECH_CHECK_CHANGED_EVENT, status)
    }
    // The outcome each path of the mock leads to, not native's rule.
    const finish = (steps: CheckStep[], outcome: CheckReport['outcome']) => publish({state: 'finished', ...mockReport(steps, outcome)})
    const run = (steps: CheckStep['kind'][], done: CheckStep[], missing: CheckStep['kind'][], outcome: CheckReport['outcome']) => {
        const check = state.speechCheck
        check.cancelled = false
        let index = 0
        const next = () => {
            if (check.cancelled) {
                finish([...done, ...steps.slice(index).map((kind) => mockStep(kind, 'cancelled'))], 'cancelled')
                return
            }
            if (index === steps.length) {
                finish(done, outcome)
                return
            }
            const kind = steps[index]
            publish({state: 'running', step: kind, steps: [...steps], done: [...done], cancelling: false})
            if (!check.autoFinish) return
            setTimeout(() => {
                if (check.cancelled) {
                    next()
                    return
                }
                done.push(mockStep(kind, missing.includes(kind) ? 'notChecked' : check.failing === kind ? 'failed' : 'passed'))
                index += 1
                next()
            }, TICK_MS)
        }
        next()
    }
    return {
        speech_check_status: () => state.speechCheck.status,
        speech_check_run: ({plan}) => {
            if (state.speechCheck.status.state === 'running') throw 'The speech check is already running'
            if (state.live.recording) throw 'The speech check can’t run during a recording'
            state.speechCheck.plans.push(plan as CheckPlan)
            // As native: a model that is not on the computer is not checked.
            run([...CHECK_STEPS], [], state.diarization.nemotronInstalled ? [] : ['nemotron'], state.speechCheck.failing ? 'failed' : 'passed')
            return null
        },
        speech_check_resume: () => {
            const status = state.speechCheck.status
            if (status.state !== 'interrupted') throw 'There is no check to resume'
            const done = status.report.steps.filter((step) => step.status !== 'closedTheApp')
            const closed = status.report.steps.filter((step) => step.status === 'closedTheApp')
            // As native, the step that closed the app fails the resumed check.
            run(status.remaining, [...done, ...closed], [], 'failed')
            return null
        },
        speech_check_cancel: () => {
            const status = state.speechCheck.status
            if (status.state !== 'running') return null
            state.speechCheck.cancelled = true
            publish({...status, cancelling: true})
            if (!state.speechCheck.autoFinish) {
                const index = status.step ? status.steps.indexOf(status.step) : 0
                finish([...status.done, ...status.steps.slice(index).map((kind) => mockStep(kind, 'cancelled'))], 'cancelled')
            }
            return null
        },
        speech_check_dismiss: () => {
            if (state.speechCheck.status.state !== 'running') publish({state: 'idle'})
            return null
        },
    }
}
