import {useIsMutating, useMutation, useQuery} from '@tanstack/react-query'
import {diarizationAvailableQuery, meetingKeys, type TranscriptSegment} from '@/api/meetings'
import {diarizeMeeting, usePostCallJob} from '@/api/postCall'
import {speakerKey, speakerParts} from '@/components/transcript/turns'
import {toast} from '@/components/ui/toastStore'

/** The counts offered, as the old dialog's quick picks were. */
export const SPEAKER_COUNTS = [2, 3, 4, 5, 6, 8] as const

/** How many voices the transcript has, overlaps split and the user counted once. */
export function countSpeakers(lines: readonly TranscriptSegment[]): number {
    const voices = new Set<string>()
    for (const line of lines) {
        if (!line.speaker?.trim()) continue
        for (const part of speakerParts(line.speaker)) voices.add(speakerKey(part))
    }
    voices.delete('')
    return voices.size
}

export const speakerCountLabel = (count: number) => `${count} ${count === 1 ? 'speaker' : 'speakers'}`

/**
 * Finds the meeting's speakers again from its audio, with a count or
 * detecting it, and relabels the transcript (text and times stay). Native
 * holds the diarization busy reason while it runs, and the run goes on if
 * the user leaves the meeting: the hook's own callbacks still refresh the
 * transcript then. `available` is false without a speaker engine, without
 * audio, or while the post-call pass runs.
 */
export function useIdentifySpeakers(meetingId: string, hasAudio: boolean) {
    const engine = useQuery(diarizationAvailableQuery)
    const job = usePostCallJob(meetingId)
    const mutationKey = [...meetingKeys.all, 'diarize', meetingId]
    // A run started before the screen was left and opened again is still this meeting's.
    const running = useIsMutating({mutationKey}) > 0
    const run = useMutation({
        mutationKey,
        mutationFn: (count: number | null) => diarizeMeeting(meetingId, count),
        onMutate: () => {
            toast.loading('Identifying speakers…', {id: `diarize-${meetingId}`, description: 'Listening to the recording on this computer.'})
        },
        onSuccess: (result, _count, _context, {client}) => {
            toast.success(result.num_speakers > 0 ? `Found ${speakerCountLabel(result.num_speakers)}` : 'No speakers found', {
                id: `diarize-${meetingId}`,
                description: `${result.labeled} ${result.labeled === 1 ? 'line' : 'lines'} relabelled.`,
            })
            return client.invalidateQueries({queryKey: meetingKeys.transcripts(meetingId)})
        },
        onError: (error) => {
            toast.error('Couldn’t identify the speakers', {id: `diarize-${meetingId}`, description: error.message})
        },
    })
    return {
        available: engine.data === true && hasAudio && !job,
        running,
        identify: (count: number | null) => run.mutate(count),
    }
}
