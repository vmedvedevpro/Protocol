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

export function mockStep(kind: CheckStep['kind'], status: CheckStep['status'] = 'passed'): CheckStep {
    const device: CheckDevice = kind === 'whisper' ? {kind: 'vulkan', name: 'GPU (Vulkan): Intel(R) Arc(TM) B390 GPU'} : {kind: 'processor', name: 'processor'}
    return {
        kind,
        status,
        reason: status === 'failed' ? 'The en clip came out with 92% of its words wrong (at most 50% pass)' : undefined,
        picked: device,
        pickedBecause: 'mock',
        inputs: [],
        ranOn: status === 'notChecked' ? undefined : device,
        clips: [],
        keepsUp: kind === 'parakeet' ? true : undefined,
    }
}

export function mockReport(steps: CheckStep[], outcome: CheckReport['outcome']): {report: CheckReport, text: string} {
    const text = [`Protocol speech check: ${outcome}`, ...steps.map((step) => `${step.kind}: ${step.status}`), '', 'JSON:', '{}'].join('\n')
    return {report: {format: 1, created: '2026-11-26T10:00:00Z', outcome, steps, warnings: []}, text}
}

export function speechCheckHandlers(state: {speechCheck: MockSpeechCheck, live: {recording: unknown}, diarization: {nemotronInstalled: boolean}}): Record<string, MockHandler> {
    const publish = (status: SpeechCheckStatus) => {
        state.speechCheck.status = status
        void emit(SPEECH_CHECK_CHANGED_EVENT, status)
    }
    const finish = (steps: CheckStep[]) => {
        // As native: a step an earlier start closed the app in fails the resumed check.
        const outcome = steps.some((step) => step.status === 'cancelled')
            ? 'cancelled'
            : steps.some((step) => step.status === 'failed' || step.status === 'closedTheApp')
                ? 'failed'
                : steps.some((step) => step.status === 'passed') ? 'passed' : 'nothingChecked'
        publish({state: 'finished', ...mockReport(steps, outcome)})
    }
    const run = (steps: CheckStep['kind'][], done: CheckStep[], missing: CheckStep['kind'][]) => {
        const check = state.speechCheck
        check.cancelled = false
        let index = 0
        const next = () => {
            if (check.cancelled) {
                finish([...done, ...steps.slice(index).map((kind) => mockStep(kind, 'cancelled'))])
                return
            }
            if (index === steps.length) {
                finish(done)
                return
            }
            const kind = steps[index]
            publish({state: 'running', step: kind, steps: [...CHECK_STEPS], done: [...done], cancelling: false})
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
            run([...CHECK_STEPS], [], state.diarization.nemotronInstalled ? [] : ['nemotron'])
            return null
        },
        speech_check_resume: () => {
            const status = state.speechCheck.status
            if (status.state !== 'interrupted') throw 'There is no check to resume'
            const done = status.report.steps.filter((step) => step.status !== 'closedTheApp')
            const closed = status.report.steps.filter((step) => step.status === 'closedTheApp')
            run(status.remaining, [...done, ...closed], [])
            return null
        },
        speech_check_cancel: () => {
            const status = state.speechCheck.status
            if (status.state !== 'running') return null
            state.speechCheck.cancelled = true
            publish({...status, cancelling: true})
            if (!state.speechCheck.autoFinish) {
                const index = status.step ? CHECK_STEPS.indexOf(status.step) : 0
                finish([...status.done, ...CHECK_STEPS.slice(index).map((kind) => mockStep(kind, 'cancelled'))])
            }
            return null
        },
        speech_check_dismiss: () => {
            if (state.speechCheck.status.state !== 'running') publish({state: 'idle'})
            return null
        },
    }
}
