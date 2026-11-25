import {useIsMutating, useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {diarizationAvailableQuery, meetingKeys, type TranscriptSegment} from '@/api/meetings'
import {diarizeMeeting, usePostCallJob} from '@/api/postCall'
import {speakerKey, speakerParts} from '@/components/transcript/turns'
import {toast} from '@/components/ui/toastStore'

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
    const client = useQueryClient()
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
            const id = `diarize-${meetingId}`
            const found = speakerCountLabel(result.num_speakers)
            const lines = (count: number) => `${count} ${count === 1 ? 'line' : 'lines'}`
            if (result.num_speakers === 0) {
                toast.success('No speakers found', {id, description: 'No line was relabelled.'})
            } else if (result.speakers_on_lines < result.num_speakers) {
                // A voice whose speech overlaps no line cannot show (#207).
                toast.warning(`Found ${found}, ${result.speakers_on_lines} on the transcript`, {
                    id,
                    description: `The speech of the others overlaps no transcript line. ${lines(result.changed)} relabelled.`,
                })
            } else if (result.changed === 0) {
                // A rerun that ends as the last one did must not look like nothing happened (#205).
                toast.success(`Found ${found} again`, {id, description: 'Every line already had these labels, so none changed.'})
            } else {
                toast.success(`Found ${found}`, {id, description: `${lines(result.changed)} relabelled.`})
            }
            return client.invalidateQueries({queryKey: meetingKeys.transcripts(meetingId)})
        },
        onError: (error) => {
            toast.error('Couldn’t identify the speakers', {id: `diarize-${meetingId}`, description: error.message})
        },
    })
    return {
        available: engine.data === true && hasAudio && !job,
        running,
        // One run at a time: a second Enter while the sheet closes must not
        // start another. The sheet keeps the `identify` of the render that
        // opened it, so the cache is read at call time, not `run.isPending`.
        identify: (count: number | null) => {
            if (client.isMutating({mutationKey}) > 0) return
            run.mutate(count)
        },
    }
}
