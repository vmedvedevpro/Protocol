import {PARAKEET_MODEL} from '@/api/models'
import {MAX_VOCABULARY_CHARS, type PostCallTranscriptConfig, type TranscriptConfig, type VocabularyConfig} from '@/api/speech'
import type {MockHandler} from './handlers'

/** The transcript config in the database (api/api.rs). */
export interface MockSpeech {
    /** The live model, as first launch leaves it: Parakeet. */
    transcriptConfig: TranscriptConfig
    /** The after-meeting model; `live` follows the live one. */
    postCallConfig: PostCallTranscriptConfig
    /** The words for every meeting, and each meeting's own by id, normalised. */
    vocabulary: {global: string, meetings: Record<string, string>}
}

export function createMockSpeech(): MockSpeech {
    return {
        transcriptConfig: {provider: 'parakeet', model: PARAKEET_MODEL},
        postCallConfig: {provider: 'live', model: ''},
        vocabulary: {global: 'Acme\nPriya Shah\nParakeet', meetings: {}},
    }
}

/**
 * What native's `VocabularyRepository::normalize` answers, or its refusal:
 * terms split on commas and line breaks, trimmed, repeats dropped
 * regardless of case, one per line.
 */
function normalized(raw: string): string {
    if (raw.includes('\0')) throw 'Vocabulary cannot contain null characters'
    const seen = new Set<string>()
    const terms: string[] = []
    for (const part of raw.split(/[,\n\r]/)) {
        const term = part.trim()
        const key = term.toLowerCase()
        if (!term || seen.has(key)) continue
        seen.add(key)
        terms.push(term)
    }
    const list = terms.join('\n')
    if ([...list].length > MAX_VOCABULARY_CHARS) throw `Vocabulary must be ${MAX_VOCABULARY_CHARS} characters or fewer`
    return list
}

/** `api_*_transcript_config`, `api_*_post_call_transcript_config` and the global vocabulary (api/api.rs). */
export function speechHandlers(state: {speech: MockSpeech}): Record<string, MockHandler> {
    const speech = () => state.speech
    return {
        api_get_transcript_config: () => ({...speech().transcriptConfig, apiKey: null}),
        api_save_transcript_config: ({provider, model}) => {
            speech().transcriptConfig = {provider: String(provider), model: String(model)}
            return {status: 'success', message: 'Transcript configuration saved successfully'}
        },
        api_get_post_call_transcript_config: () => ({...speech().postCallConfig}),
        api_save_post_call_transcript_config: ({provider, model}) => {
            const engine = String(provider)
            if (engine !== 'live' && engine !== 'whisper' && engine !== 'parakeet') throw 'Invalid post-call transcription provider'
            const name = String(model ?? '').trim()
            if (engine !== 'live' && !name) throw 'A post-call transcription model is required'
            speech().postCallConfig = {provider: engine, model: engine === 'live' ? '' : name}
            return null
        },
        api_get_vocabulary: ({meetingId}): VocabularyConfig => ({
            global: speech().vocabulary.global,
            meeting: meetingId ? speech().vocabulary.meetings[String(meetingId)] ?? '' : '',
        }),
        api_save_global_vocabulary: ({vocabulary}) => {
            const list = normalized(String(vocabulary ?? ''))
            speech().vocabulary.global = list
            return list
        },
    }
}
