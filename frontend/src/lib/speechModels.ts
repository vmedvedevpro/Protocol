/**
 * The speech models a picker offers, and the one it starts from: the
 * downloaded models, the after-meeting model by default. Import and
 * Improve the transcript (features/dialogs) and Settings' speech pickers
 * share these rules, pure over the src/api types. The old pickers'
 * rules (`162e8be`: `lib/speech-models.ts`, `hooks/useTranscriptionModels.ts`):
 * Parakeet first, Parakeet v2 no longer offered while it stays on disk, and
 * Whisper's Intel GPU version named after the model it serves.
 */
import type {ParakeetModelInfo, WhisperModelInfo} from '@/api/models'
import {isWhisperProvider, type PostCallTranscriptConfig, type TranscriptConfig} from '@/api/speech'

export type SpeechEngine = 'parakeet' | 'whisper'

export interface SpeechModelChoice {
    /** `engine:name`, a Select's value. */
    value: string
    engine: SpeechEngine
    name: string
    /** "Whisper · Large V3 Turbo", "Whisper · Large V3 Turbo · Intel GPU". */
    label: string
}

// Kept natively for old installs, no longer offered.
const RETIRED_PARAKEET = 'parakeet-tdt-0.6b-v2-int8'

const ENGINE_NAMES: Record<SpeechEngine, string> = {parakeet: 'Parakeet', whisper: 'Whisper'}

function label(engine: SpeechEngine, name: string, displayName: string, gpu = false): string {
    const own = displayName.trim().replace(new RegExp(`^${ENGINE_NAMES[engine]}\\s+`, 'i'), '') || name
    return `${ENGINE_NAMES[engine]} · ${own}${gpu ? ' · Intel GPU' : ''}`
}

/** The downloaded models, Parakeet first. */
export function speechModelChoices(parakeet: readonly ParakeetModelInfo[], whisper: readonly WhisperModelInfo[]): SpeechModelChoice[] {
    return [
        ...parakeet
            .filter((model) => model.status === 'Available' && model.name !== RETIRED_PARAKEET)
            .map((model) => ({value: `parakeet:${model.name}`, engine: 'parakeet' as const, name: model.name, label: label('parakeet', model.name, model.display_name)})),
        ...whisper
            .filter((model) => model.status === 'Available')
            .map((model) => ({
                value: `whisper:${model.name}`,
                engine: 'whisper' as const,
                name: model.name,
                label: label('whisper', model.name, model.display_name, !!model.companion_of?.length),
            })),
    ]
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
        ? whisper.find((model) => model.status === 'Available' && model.companion_of?.includes(name))
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
