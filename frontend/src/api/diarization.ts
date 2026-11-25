/**
 * The speaker engine: Pyannote, built in, or NVIDIA Nemotron, downloaded on
 * demand (diarization/mod.rs, `diarization_config.json`). Settings › AI ›
 * Speakers chooses it and sets Nemotron's speech threshold; the meeting's
 * speaker dialogs (#119) read which runs. Mirrors `DiarizationEngineStatus`
 * and `DownloadProgress` in diarization/download.rs.
 *
 * Nemotron activates natively once its download is verified
 * (`download_diarization_models` saves the engine before it resolves and
 * sends `diarization-engine-changed`); its removal is
 * `uninstallOptionalModel('nemotron')` (models.ts), which puts Pyannote
 * back first. A failed Nemotron is reported, never replaced by Pyannote in
 * silence (AGENTS.md).
 */
import {mutationOptions, queryOptions} from '@tanstack/react-query'
import {command} from './core'
import type {NativeEvent} from './events'

export type SpeakerEngine = 'pyannote' | 'nemotron'

export interface DiarizationStatus {
    /** Lowercase; an unknown value reads as Pyannote. */
    active_engine: string
    pyannote_available: boolean
    nemotron_available: boolean
    /** The chosen engine's models are there. */
    current_available: boolean
    model_dir: string
    nemotron_max_speakers: number
    nemotron_threshold: number
    pyannote_threshold: number
    /** Bytes; 0 when none is on record. */
    nemotron_download_size: number
    pyannote_download_size: number
}

export const activeEngine = (status: DiarizationStatus | undefined): SpeakerEngine =>
    status?.active_engine.toLowerCase() === 'nemotron' ? 'nemotron' : 'pyannote'

/** Nemotron's threshold: the range and step native accepts and the old slider offered. */
export const THRESHOLD = {min: 0.1, max: 0.9, step: 0.05, default: 0.5} as const

export const getDiarizationStatus = () => command<DiarizationStatus>('diarization_get_status')

export const setDiarizationEngine = (engine: SpeakerEngine) => command<null>('set_diarization_engine', {engine})

/** Saves the thresholds; native keeps Nemotron's speaker capacity at 8 whatever it is sent. */
export const setNemotronThreshold = (status: DiarizationStatus, nemotronThreshold: number) =>
    command<null>('set_diarization_config', {
        engine: status.active_engine,
        nemotronThreshold,
        pyannoteThreshold: status.pyannote_threshold,
    })

/**
 * Downloads Nemotron and resolves once it is verified and chosen. Rejects
 * with "Model downloaded, but could not enable it: …" when the choice could
 * not be saved, and while another speaker download runs.
 */
export const downloadNemotron = () => command<null>('download_diarization_models', {engine: 'nemotron'})

/** What a cancelled download rejects with (download.rs `CANCELLED`). */
export const DIARIZATION_DOWNLOAD_CANCELLED = 'Download cancelled'

/** Stops Nemotron's download; it rejects with `DIARIZATION_DOWNLOAD_CANCELLED` and leaves nothing behind. */
export const cancelNemotronDownload = () => command<null>('cancel_diarization_download')

export const openSpeakerModelFolder = () => command<null>('open_diarization_model_directory')

/** Native chose an engine itself: Nemotron after its download, Pyannote after its removal. */
export const DIARIZATION_ENGINE_CHANGED_EVENT = 'diarization-engine-changed' as NativeEvent<SpeakerEngine>

export interface DiarizationDownloadProgress {
    file: string
    file_index: number
    file_count: number
    /** Bytes of the current file only. */
    downloaded: number
    total: number
    /** The whole download, 0 to 100; 100 only with `done`. */
    percent: number
    /** `error` and `cancelled` end a download that did not finish. */
    status: 'downloading' | 'verifying' | 'skipped' | 'done' | 'error' | 'cancelled'
    message?: string
}

export const DIARIZATION_DOWNLOAD_PROGRESS_EVENT = 'diarization-download-progress' as NativeEvent<DiarizationDownloadProgress>

/** The model `downloadKey('nemotron', …)` names. */
export const NEMOTRON = 'nemotron'

export const diarizationKeys = {
    all: ['diarization'] as const,
    status: () => [...diarizationKeys.all, 'status'] as const,
}

export const diarizationStatusQuery = queryOptions({
    queryKey: diarizationKeys.status(),
    queryFn: getDiarizationStatus,
})

/** Choosing an engine, shown at once and read again after. */
export const setDiarizationEngineMutation = () =>
    mutationOptions({
        mutationFn: setDiarizationEngine,
        scope: {id: 'diarization-config'},
        onMutate: async (engine, {client}) => {
            const {queryKey} = diarizationStatusQuery
            await client.cancelQueries({queryKey})
            client.setQueryData(queryKey, (status) => status && {
                ...status,
                active_engine: engine,
                current_available: engine === 'nemotron' ? status.nemotron_available : status.pyannote_available,
            })
        },
        onSettled: (_reply, _error, _engine, _result, {client}) => client.invalidateQueries({queryKey: diarizationKeys.status()}),
    })

/** Saving Nemotron's threshold; same scope as the engine, so the two writes never cross. */
export const setNemotronThresholdMutation = () =>
    mutationOptions({
        mutationFn: async (threshold: number) => setNemotronThreshold(await getDiarizationStatus(), threshold),
        scope: {id: 'diarization-config'},
        onMutate: async (threshold, {client}) => {
            const {queryKey} = diarizationStatusQuery
            await client.cancelQueries({queryKey})
            client.setQueryData(queryKey, (status) => status && {...status, nemotron_threshold: threshold})
        },
        onSettled: (_reply, _error, _threshold, _result, {client}) => client.invalidateQueries({queryKey: diarizationKeys.status()}),
    })
