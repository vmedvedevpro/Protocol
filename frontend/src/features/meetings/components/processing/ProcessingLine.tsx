import {usePostCallJob} from '@/api/postCall'
import {StatusLine} from '@/components/ui/StatusLine'
import {postCallStatusText, useRemainingText} from './progress'

/**
 * One line for a meeting in a list while its post-call pass runs, as Home's
 * row shows it: "Improving the transcript (about 2 min)" after a spinner, or
 * what failed. Nothing once the pass has ended, so a row can render it in
 * place of its usual second line whenever `usePostCallJob` returns a job.
 */
export function ProcessingLine({meetingId}: { meetingId: string }) {
    const job = usePostCallJob(meetingId)
    const remaining = useRemainingText(job)
    if (!job) return null
    return (
        <StatusLine
            status={{
                key: `${job.state}:${job.step}`,
                text: postCallStatusText(job),
                value: remaining ? `(${remaining})` : undefined,
                busy: job.state !== 'failed',
            }}
        />
    )
}
