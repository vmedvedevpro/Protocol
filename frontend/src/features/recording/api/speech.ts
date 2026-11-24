/**
 * What a start checks before capture opens (PARITY.md, Recording start
 * order): the speech runtime (onnx_runtime.rs), then the live model, loaded
 * ahead so the first words are transcribed at once. Native checks the model
 * again on start (`validate_transcription_model_ready`); loading it here
 * first lets the start say why it cannot record: an integrity failure, a
 * download still running, or no model at all.
 */
import {command} from '@/api/core'
import {getParakeetModels, getWhisperModels, type SpeechModelStatus} from '@/api/models'

/** The prefix native puts on a runtime that cannot start (onnx_runtime.rs `START_ERROR_CODE`). */
const RUNTIME_ERROR = 'TRANSCRIPTION_RUNTIME_INITIALIZATION_FAILED'

/** The text of a rejected command: usually a string, sometimes an Error or an object. */
function errorText(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === 'string') return error
    if (error == null) return ''
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
    try {
        return JSON.stringify(error) ?? String(error)
    } catch {
        return String(error)
    }
}

/** The runtime's reason, or null when `error` is not a runtime failure. */
export function runtimeMessage(error: unknown): string | null {
    const text = errorText(error)
    if (!text.startsWith(RUNTIME_ERROR)) return null
    return text.slice(RUNTIME_ERROR.length).replace(/^:\s*/, '')
        || 'Speech recognition could not initialize. Restart Protocol; if it continues, repair or reinstall the app.'
}

/**
 * A model that failed its pinned checksum, in the words a native start
 * uses too (`model_unavailable_message` in recording_commands.rs); null for
 * any other failure.
 */
export function modelIntegrityMessage(error: unknown): string | null {
    const text = errorText(error)
    if (text.includes('failed its integrity check and could not be deleted')) {
        return 'The speech model failed its integrity check and could not be deleted. Close any program that has it open, then download it again in Speech models.'
    }
    if (!text.includes('failed its integrity check')) return null
    return 'The speech model failed its integrity check and was deleted. Download it again in Speech models.'
}

/** A readable reason for a rejected start, from native's text. */
export function describeStartError(error: unknown): { title: string, message: string } {
    const raw = errorText(error)
    const text = raw.toLowerCase()
    // Only "not currently running" means opening an app helps; other
    // per-app failures fall through to native's own reason.
    if (text.includes('target application') && text.includes('currently running')) {
        return {
            title: 'None of your chosen apps is open',
            message: 'Computer audio records only the apps chosen in Settings. Open one of them, or record all computer audio.',
        }
    }
    if (text.includes('microphone') || text.includes('mic') || text.includes('input')) {
        return {
            title: 'Microphone not available',
            message: 'Check that the microphone is connected, that Protocol may use it, and that no other app has taken it.',
        }
    }
    if (text.includes('system audio') || text.includes('speaker') || text.includes('output')) {
        return {
            title: 'Computer audio not available',
            message: 'On macOS, allow Protocol Audio Capture in Privacy & Security, play some audio and try again. Elsewhere, check the output device in Settings.',
        }
    }
    if (text.includes('permission')) {
        return {
            title: 'Permission needed',
            message: 'Allow microphone access (and Audio Capture on macOS) in your system settings, then restart Protocol.',
        }
    }
    const reason = raw.replace(/^Failed to start recording:\s*/i, '').trim()
    return {title: 'Could not start recording', message: reason || 'Check your audio devices in Settings and try again.'}
}

/** Mirrors api.rs `TranscriptConfig`: the live model Settings chose (#117 owns choosing it). */
interface TranscriptConfig {
    provider: string
    model: string
}

const getTranscriptConfig = () => command<TranscriptConfig | null>('api_get_transcript_config')

const isAvailable = (status: SpeechModelStatus) => status === 'Available'
const isDownloading = (status: SpeechModelStatus) => typeof status === 'object' && 'Downloading' in status

/** Why the live model cannot record yet. */
export type SpeechProblem =
    | { kind: 'runtime', message: string }
    | { kind: 'integrity', message: string }
    | { kind: 'downloading' }
    | { kind: 'missing' }

/**
 * Checks the runtime and loads the live model: Parakeet unless Settings
 * chose Whisper (`localWhisper`), the configured model when it is there,
 * else the first one downloaded. Resolves null when it is ready.
 */
export async function prepareSpeech(): Promise<SpeechProblem | null> {
    try {
        await command<null>('check_transcription_runtime')
    } catch (error) {
        return {kind: 'runtime', message: runtimeMessage(error) ?? 'Could not check the speech runtime. Restart Protocol and try again.'}
    }

    try {
        const config = await getTranscriptConfig().catch(() => null)
        const provider = (config?.provider ?? 'parakeet').toLowerCase()
        if (provider.includes('whisper')) {
            await command<null>('whisper_init')
            if (!(await command<boolean>('whisper_has_available_models'))) return {kind: 'missing'}
            if (!(await command<boolean>('whisper_is_model_loaded'))) {
                await command<null>('whisper_load_model', {modelName: config?.model || 'large-v3'})
            }
            return null
        }
        const models = await getParakeetModels()
        if (!(await command<boolean>('parakeet_has_available_models'))) {
            return models.some((model) => isDownloading(model.status)) ? {kind: 'downloading'} : {kind: 'missing'}
        }
        if (!(await command<boolean>('parakeet_is_model_loaded'))) {
            const ready = models.find((model) => model.name === config?.model && isAvailable(model.status))
                ?? models.find((model) => isAvailable(model.status))
            if (ready) await command<null>('parakeet_load_model', {modelName: ready.name})
        }
        return null
    } catch (error) {
        const integrity = modelIntegrityMessage(error)
        if (integrity) return {kind: 'integrity', message: integrity}
        throw error
    }
}

/** Mirrors api.rs `PostCallTranscriptConfig`: `live` follows the live model. */
interface PostCallTranscriptConfig {
    provider: 'live' | 'whisper' | 'parakeet'
    model: string
}

/** The model that improves a transcript after the call. */
export interface PostCallModel {
    provider: 'parakeet' | 'whisper'
    name: string
}

/**
 * The model the post-call pass retranscribes with: the one Settings chose
 * for after the call, or the live model, when it is downloaded; else another
 * of the same engine; else any downloaded one, Parakeet first. The Intel GPU
 * version of a Whisper model (`companion_of`) stands in for it.
 */
export async function resolvePostCallModel(): Promise<PostCallModel> {
    const [postCall, live, parakeet, whisper] = await Promise.all([
        command<PostCallTranscriptConfig>('api_get_post_call_transcript_config').catch(() => ({provider: 'live' as const, model: ''})),
        getTranscriptConfig().catch(() => null),
        getParakeetModels().catch(() => []),
        getWhisperModels().catch(() => []),
    ])
    const available: PostCallModel[] = [
        ...parakeet.filter((model) => isAvailable(model.status)).map((model) => ({provider: 'parakeet' as const, name: model.name})),
        ...whisper.filter((model) => isAvailable(model.status)).map((model) => ({provider: 'whisper' as const, name: model.name})),
    ]
    const followsLive = postCall.provider === 'live'
    const wantedProvider = (followsLive ? live?.provider : postCall.provider)?.toLowerCase().replace('localwhisper', 'whisper')
    const wantedModel = followsLive ? live?.model : postCall.model
    const configured = available.find((model) => model.provider === wantedProvider && model.name === wantedModel)
    if (configured) return configured
    const companion = whisper.some((model) => isAvailable(model.status) && model.companion_of?.includes(wantedModel ?? ''))
    if (wantedProvider === 'whisper' && wantedModel && companion) return {provider: 'whisper', name: wantedModel}
    if (wantedProvider === 'whisper' || wantedProvider === 'parakeet') {
        const same = available.find((model) => model.provider === wantedProvider)
        if (same) return same
        throw new Error(`No downloaded ${wantedProvider === 'whisper' ? 'Whisper' : 'Parakeet'} model can improve the transcript.`)
    }
    const fallback = available.find((model) => model.provider === 'parakeet') ?? available[0]
    if (fallback) return fallback
    throw new Error('No downloaded speech model can improve the transcript.')
}
