/**
 * A meeting's own words to recognize (api/api.rs `api_save_meeting_vocabulary`),
 * which only Enhance transcript changes; the lists themselves and the
 * global one are src/api/speech.ts.
 */
import {mutationOptions} from '@tanstack/react-query'
import {command} from '@/api/core'
import {speechKeys} from '@/api/speech'

/** Replaces the meeting's list and answers it normalised; an empty one clears it. */
export const saveMeetingVocabulary = (meetingId: string, vocabulary: string) =>
    command<string>('api_save_meeting_vocabulary', {meetingId, vocabulary})

export const clearMeetingVocabularyMutation = (meetingId: string) =>
    mutationOptions({
        mutationFn: () => saveMeetingVocabulary(meetingId, ''),
        onSettled: (_list, _error, _variables, _result, {client}) =>
            client.invalidateQueries({queryKey: speechKeys.vocabularies()}),
    })
