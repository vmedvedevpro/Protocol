import {useQuery} from '@tanstack/react-query'
import {parakeetModelsQuery, whisperModelsQuery} from '@/api/models'
import {postCallConfigQuery, transcriptConfigQuery} from '@/api/speech'
import {defaultSpeechModel, speechModelChoices} from '@/lib/speechModels'

/** The choices and the default, once the lists and the configs have answered. */
export function useSpeechModels() {
    const parakeet = useQuery(parakeetModelsQuery)
    const whisper = useQuery(whisperModelsQuery)
    const postCall = useQuery(postCallConfigQuery)
    const live = useQuery(transcriptConfigQuery)
    // A config that failed to read leaves the default to the lists.
    const pending = parakeet.isPending || whisper.isPending || postCall.isPending || live.isPending
    const choices = speechModelChoices(parakeet.data ?? [], whisper.data ?? [])
    return {
        pending,
        choices,
        initial: pending ? undefined : defaultSpeechModel(choices, whisper.data ?? [], postCall.data, live.data),
    }
}
