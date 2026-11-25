import {emit} from '@tauri-apps/api/event'
import type {NativeEvent} from '@/api/events'
import {
    DIARIZATION_DOWNLOAD_CANCELLED,
    DIARIZATION_DOWNLOAD_PROGRESS_EVENT,
    DIARIZATION_ENGINE_CHANGED_EVENT,
    type DiarizationStatus,
    type SpeakerEngine,
} from '@/api/diarization'
import type {MockHandler} from './handlers'

const NEMOTRON_BYTES = 479_903_744
const TICK_MS = 250

/** The speaker engine as `diarization_config.json` and the model folder hold it. */
export interface MockDiarization {
    engine: SpeakerEngine
    nemotronInstalled: boolean
    nemotronThreshold: number
    /** Percent a fake Nemotron download gains each tick. */
    downloadStep: number
    /** The next Nemotron download fails halfway. */
    failNext: boolean
    /** The folder `open_diarization_model_directory` opened, for tests. */
    opened: number
}

export function createMockDiarization(): MockDiarization {
    return {engine: 'pyannote', nemotronInstalled: false, nemotronThreshold: 0.5, downloadStep: 10, failNext: false, opened: 0}
}

const send = <T, >(event: NativeEvent<T>, payload: T) => void emit(event, payload).catch(() => undefined)

/** diarization/mod.rs: the engine, its threshold and Nemotron's download. */
export function diarizationHandlers(state: {diarization: MockDiarization}): Record<string, MockHandler> {
    const diarization = () => state.diarization
    let downloading = false
    let cancelled = false
    return {
        diarization_get_status: (): DiarizationStatus => ({
            active_engine: diarization().engine,
            pyannote_available: true,
            nemotron_available: diarization().nemotronInstalled,
            current_available: diarization().engine === 'pyannote' || diarization().nemotronInstalled,
            model_dir: '/home/user/.local/share/protocol/models/diarization',
            nemotron_max_speakers: 8,
            nemotron_threshold: diarization().nemotronThreshold,
            pyannote_threshold: 0.5,
            nemotron_download_size: NEMOTRON_BYTES,
            pyannote_download_size: 0,
        }),
        set_diarization_engine: ({engine}) => {
            diarization().engine = String(engine).toLowerCase() === 'nemotron' ? 'nemotron' : 'pyannote'
            return null
        },
        set_diarization_config: ({nemotronThreshold}) => {
            if (typeof nemotronThreshold === 'number') diarization().nemotronThreshold = nemotronThreshold
            return null
        },
        open_diarization_model_directory: () => {
            diarization().opened += 1
            return null
        },
        download_diarization_models: ({engine}) => {
            if (engine !== 'nemotron') throw 'Unknown diarization engine'
            if (downloading) throw 'A diarization download is already running'
            downloading = true
            cancelled = false
            const fails = diarization().failNext
            diarization().failNext = false
            return new Promise((resolve, reject) => {
                let percent = 0
                const timer = setInterval(() => {
                    percent = Math.min(100, percent + diarization().downloadStep)
                    const progress = {file: 'nemotron3_diar_v3.onnx', file_index: 1, file_count: 2, downloaded: (NEMOTRON_BYTES * percent) / 100, total: NEMOTRON_BYTES}
                    if (cancelled) {
                        clearInterval(timer)
                        downloading = false
                        send(DIARIZATION_DOWNLOAD_PROGRESS_EVENT, {...progress, percent: 0, status: 'cancelled', message: DIARIZATION_DOWNLOAD_CANCELLED})
                        reject(DIARIZATION_DOWNLOAD_CANCELLED)
                        return
                    }
                    if (fails && percent >= 50) {
                        clearInterval(timer)
                        downloading = false
                        send(DIARIZATION_DOWNLOAD_PROGRESS_EVENT, {...progress, percent, status: 'error', message: 'Network error'})
                        reject('Network error')
                        return
                    }
                    if (percent < 100) {
                        send(DIARIZATION_DOWNLOAD_PROGRESS_EVENT, {...progress, percent: Math.min(percent, 99), status: 'downloading'})
                        return
                    }
                    clearInterval(timer)
                    downloading = false
                    // Native verifies, saves the engine, then says so.
                    diarization().nemotronInstalled = true
                    diarization().engine = 'nemotron'
                    send(DIARIZATION_DOWNLOAD_PROGRESS_EVENT, {...progress, percent: 100, status: 'done'})
                    send(DIARIZATION_ENGINE_CHANGED_EVENT, 'nemotron')
                    resolve(null)
                }, TICK_MS)
            })
        },
        cancel_diarization_download: () => {
            if (downloading) cancelled = true
            return null
        },
    }
}
