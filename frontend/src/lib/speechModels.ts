/**
 * The speech models a picker offers, and the one it starts from: the
 * downloaded models, the after-meeting model by default. Import and
 * Improve the transcript (features/dialogs) and Settings' speech pickers
 * share these rules, pure over the src/api types. The old pickers'
 * rules (`162e8be`: `lib/speech-models.ts`, `hooks/useTranscriptionModels.ts`):
 * Parakeet first, Parakeet v2 no longer offered while it stays on disk, and
 * Whisper's Intel GPU version named after the model it serves.
 */
import type {ParakeetModelInfo, SpeechModelStatus, WhisperModelInfo} from '@/api/models'
import {isWhisperProvider, type PostCallTranscriptConfig, type TranscriptConfig} from '@/api/speech'

export type SpeechEngine = 'parakeet' | 'whisper'

export interface SpeechModelChoice {
    /** `engine:name`, a Select's value. */
    value: string
    engine: SpeechEngine
    name: string
    /** "Whisper Large V3 Turbo", "Whisper Large V3 Turbo (Intel GPU)". */
    label: string
}

// Kept natively for old installs, no longer offered.
const RETIRED_PARAKEET = 'parakeet-tdt-0.6b-v2-int8'

/** Parakeet v2 is no longer offered, even while it is on disk. */
export const isOfferedParakeet = (name: string) => name !== RETIRED_PARAKEET

/** The Intel GPU version of a Whisper model lists the models it serves (`companion_of`). */
export const isGpuVersion = (model: {companion_of?: string[]} | undefined | null) => !!model?.companion_of?.length

export const isInstalled = (status: SpeechModelStatus | undefined) => status === 'Available'

/** A copy that failed its size or integrity check: it is removed before it downloads again. */
export const isCorrupted = (status: SpeechModelStatus | undefined) => typeof status === 'object' && 'Corrupted' in status

const ENGINE_NAMES: Record<SpeechEngine, string> = {parakeet: 'Parakeet', whisper: 'Whisper'}

/**
 * "Whisper Large V3 Turbo": the engine, then the catalog's name without an
 * engine name it may repeat, or the id when it has none. The Intel GPU
 * version reads apart from the model it serves.
 */
export function speechModelLabel(engine: SpeechEngine, model: {name: string, display_name?: string | null, companion_of?: string[]}): string {
    const own = (model.display_name ?? '').trim().replace(new RegExp(`^${ENGINE_NAMES[engine]}\\s+`, 'i'), '') || model.name
    return `${ENGINE_NAMES[engine]} ${own}${isGpuVersion(model) ? ' (Intel GPU)' : ''}`
}

const choice = (engine: SpeechEngine, model: {name: string, display_name?: string | null, companion_of?: string[]}): SpeechModelChoice =>
    ({value: `${engine}:${model.name}`, engine, name: model.name, label: speechModelLabel(engine, model)})

/** The downloaded models, Parakeet first. */
export function speechModelChoices(parakeet: readonly ParakeetModelInfo[], whisper: readonly WhisperModelInfo[]): SpeechModelChoice[] {
    return [
        ...parakeet.filter((model) => isInstalled(model.status) && isOfferedParakeet(model.name)).map((model) => choice('parakeet', model)),
        ...whisper.filter((model) => isInstalled(model.status)).map((model) => choice('whisper', model)),
    ]
}

/**
 * The choices with the saved model added when it is not among them, marked
 * as not downloaded, so a picker shows what is saved as a device list shows
 * a device that is not connected.
 */
export function withSavedModel(choices: readonly SpeechModelChoice[], saved: string | null | undefined): SpeechModelChoice[] {
    const parsed = parseSpeechModel(saved ?? undefined)
    if (!saved || !parsed || choices.some(({value}) => value === saved)) return [...choices]
    return [...choices, {
        value: saved,
        engine: parsed.provider,
        name: parsed.model,
        label: `${ENGINE_NAMES[parsed.provider]} ${parsed.model} (not downloaded)`,
    }]
}

/**
 * The model to start from: the after-meeting model, or the live one when
 * that follows it, if downloaded; else the Intel GPU version serving it;
 * else another of the same engine; else the first. Undefined with none.
 */
export function defaultSpeechModel(
    choices: readonly SpeechModelChoice[],
    whisper: readonly WhisperModelInfo[],
    postCall: PostCallTranscriptConfig | undefined,
    live: TranscriptConfig | null | undefined,
): string | undefined {
    const followsLive = !postCall || postCall.provider === 'live'
    const provider = followsLive ? live?.provider : postCall.provider
    const engine: SpeechEngine | null = !provider ? null : isWhisperProvider(provider) ? 'whisper' : provider === 'parakeet' ? 'parakeet' : null
    const name = followsLive ? live?.model : postCall.model
    const exact = choices.find((choice) => choice.engine === engine && choice.name === name)
    if (exact) return exact.value
    const servedBy = engine === 'whisper' && name
        ? whisper.find((model) => isInstalled(model.status) && model.companion_of?.includes(name))
        : undefined
    if (servedBy) return `whisper:${servedBy.name}`
    return (choices.find((choice) => choice.engine === engine) ?? choices[0])?.value
}

/** The engine and model a choice's value names. */
export function parseSpeechModel(value: string | undefined): { provider: SpeechEngine, model: string } | null {
    const at = value?.indexOf(':') ?? -1
    if (!value || at < 0) return null
    const provider = value.slice(0, at)
    return provider === 'parakeet' || provider === 'whisper' ? {provider, model: value.slice(at + 1)} : null
}
