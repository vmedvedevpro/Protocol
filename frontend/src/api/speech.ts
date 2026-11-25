/**
 * The transcript config: the model that writes the live text, the one that
 * improves the transcript after the meeting, and the words to recognize.
 * Native code keeps them in the database (the `transcript_settings` and
 * vocabulary tables, api/api.rs); the types mirror `TranscriptConfig`,
 * `PostCallTranscriptConfig` and `VocabularyConfig` there.
 *
 * Settings changes them (#117); a recording's start reads the live model
 * (`features/recording/api/speech.ts`), the post-call pass and Enhance
 * transcript (#119) the after-meeting model and the vocabulary. Native code
 * also changes the two models itself: a Whisper download with
 * `enablePostCall`, a removal (`uninstall_optional_model`) and the Intel GPU
 * version (speech_choice.rs) save them and say so with the two events below;
 * `useSpeechConfigSync` reads them again then.
 */
import {mutationOptions, queryOptions, useQueryClient} from '@tanstack/react-query'
import {command} from './core'
import {type NativeEvent, useNativeEvent} from './events'

// --- The live model ----------------------------------------------------------

/**
 * Which engine writes the live text: Parakeet, or Whisper, saved as
 * `localWhisper` (native also reads an older `whisper`).
 */
export type LiveProvider = 'parakeet' | 'localWhisper'

/**
 * Mirrors api.rs `TranscriptConfig`, without the key of the cloud providers
 * the old app offered, which the local engines never read. Native answers
 * its own default (Parakeet) when nothing is saved.
 */
export interface TranscriptConfig {
    /** `parakeet` or `localWhisper`; older databases may hold `whisper` or a cloud provider. */
    provider: string
    model: string
}

/** Whether a saved provider names Whisper (`localWhisper`, or the older `whisper`). */
export const isWhisperProvider = (provider: string | undefined) => !!provider && /whisper/i.test(provider)

export const getTranscriptConfig = () => command<TranscriptConfig | null>('api_get_transcript_config')

/** Saves the live model. The local engines take no key, so none is sent (native's is optional). */
export const saveTranscriptConfig = ({provider, model}: {provider: LiveProvider, model: string}) =>
    command<unknown>('api_save_transcript_config', {provider, model})

// --- The after-meeting model -------------------------------------------------

/** `live` follows the live model; the others name the engine of `model`. */
export type PostCallProvider = 'live' | 'whisper' | 'parakeet'

/** Mirrors api.rs `PostCallTranscriptConfig`; `model` is empty with `live`. */
export interface PostCallTranscriptConfig {
    provider: PostCallProvider
    model: string
}

export const getPostCallTranscriptConfig = () => command<PostCallTranscriptConfig>('api_get_post_call_transcript_config')

/**
 * Saves the after-meeting model. Native refuses an unknown provider and an
 * empty model for an engine; it stores no model with `live`.
 */
export const savePostCallTranscriptConfig = ({provider, model}: PostCallTranscriptConfig) =>
    command<null>('api_save_post_call_transcript_config', {provider, model})

// --- Words to recognize ------------------------------------------------------

/** Mirrors api.rs `VocabularyConfig`: the words for every meeting, and one meeting's own. */
export interface VocabularyConfig {
    global: string
    /** Empty without a meeting id. */
    meeting: string
}

/**
 * The most characters a list may have once native has normalised it
 * (vocabulary.rs `MAX_VOCABULARY_CHARS`): split on commas and line breaks,
 * trimmed, repeats dropped, one per line.
 */
export const MAX_VOCABULARY_CHARS = 1000

/** The global list, and with a meeting id that meeting's list too. */
export const getVocabulary = (meetingId: string | null = null) => command<VocabularyConfig>('api_get_vocabulary', {meetingId})

/**
 * Saves the list for every meeting and answers it normalised. Rejects when
 * it is longer than `MAX_VOCABULARY_CHARS` once normalised.
 */
export const saveGlobalVocabulary = (vocabulary: string) => command<string>('api_save_global_vocabulary', {vocabulary})

// --- Events ----------------------------------------------------------------

/** Native code changed the live model (an optional model removed, the Intel GPU version chosen or removed). */
export const TRANSCRIPT_CONFIG_CHANGED_EVENT = 'transcript-config-changed' as NativeEvent<null>
/** Native code changed the after-meeting model (Whisper activated after its download, a removal, the Intel GPU version). */
export const POST_CALL_TRANSCRIPT_CONFIG_CHANGED_EVENT = 'post-call-transcript-config-changed' as NativeEvent<null>

// --- Queries ---------------------------------------------------------------

export const speechKeys = {
    all: ['speech'] as const,
    transcriptConfig: () => [...speechKeys.all, 'transcriptConfig'] as const,
    postCallConfig: () => [...speechKeys.all, 'postCallConfig'] as const,
    vocabularies: () => [...speechKeys.all, 'vocabulary'] as const,
    vocabulary: (meetingId: string | null = null) => [...speechKeys.vocabularies(), meetingId ?? 'global'] as const,
}

export const transcriptConfigQuery = queryOptions({
    queryKey: speechKeys.transcriptConfig(),
    queryFn: getTranscriptConfig,
})

export const postCallConfigQuery = queryOptions({
    queryKey: speechKeys.postCallConfig(),
    queryFn: getPostCallTranscriptConfig,
})

export const vocabularyQuery = (meetingId: string | null = null) => queryOptions({
    queryKey: speechKeys.vocabulary(meetingId),
    queryFn: () => getVocabulary(meetingId),
})

/**
 * Changing the live model. The cached config shows the choice at once and
 * is read again once the save lands or fails.
 */
export const saveTranscriptConfigMutation = () =>
    mutationOptions({
        mutationFn: saveTranscriptConfig,
        scope: {id: 'transcript-config'},
        onMutate: async ({provider, model}, {client}) => {
            const {queryKey} = transcriptConfigQuery
            await client.cancelQueries({queryKey})
            client.setQueryData(queryKey, (): TranscriptConfig => ({provider, model}))
        },
        onSettled: (_reply, _error, _config, _result, {client}) =>
            client.invalidateQueries({queryKey: speechKeys.transcriptConfig()}),
    })

/** Changing the after-meeting model, shown at once like the live one. */
export const savePostCallConfigMutation = () =>
    mutationOptions({
        mutationFn: savePostCallTranscriptConfig,
        scope: {id: 'post-call-config'},
        onMutate: async (config, {client}) => {
            const {queryKey} = postCallConfigQuery
            await client.cancelQueries({queryKey})
            client.setQueryData(queryKey, {provider: config.provider, model: config.provider === 'live' ? '' : config.model})
        },
        onSettled: (_reply, _error, _config, _result, {client}) =>
            client.invalidateQueries({queryKey: speechKeys.postCallConfig()}),
    })

/** Saving the global list; every vocabulary read again after it, a meeting's included (it merges both). */
export const saveGlobalVocabularyMutation = () =>
    mutationOptions({
        mutationFn: saveGlobalVocabulary,
        scope: {id: 'vocabulary'},
        onSettled: (_reply, _error, _vocabulary, _result, {client}) =>
            client.invalidateQueries({queryKey: speechKeys.vocabularies()}),
    })

/**
 * Reads the models again when native code changes them. The events carry
 * nothing, so they only invalidate. Mounted once, by the shell beside
 * `useModelDownloadSync`, so a change made while no screen shows the models
 * is read when one does.
 */
export function useSpeechConfigSync() {
    const queryClient = useQueryClient()
    useNativeEvent(TRANSCRIPT_CONFIG_CHANGED_EVENT, () => {
        void queryClient.invalidateQueries({queryKey: speechKeys.transcriptConfig()})
    })
    useNativeEvent(POST_CALL_TRANSCRIPT_CONFIG_CHANGED_EVENT, () => {
        void queryClient.invalidateQueries({queryKey: speechKeys.postCallConfig()})
    })
}
