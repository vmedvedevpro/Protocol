import {useState} from 'react'
import {useMutation, useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {
    cancelSummaryMutation,
    isSummaryRunning,
    type SummaryResponse,
    saveSummaryMutation,
    summaryQuery,
} from '@/api/meetings'
import {usePostCallJob} from '@/api/postCall'
import {type NotesContent, NotesEditor} from '@/components/editor/NotesEditor'
import {Button} from '@/components/ui/Button'
import {Spinner} from '@/components/ui/Spinner'
import {StatusLine} from '@/components/ui/StatusLine'
import {toast} from '@/components/ui/toastStore'
import {ProcessingSteps} from '../components/processing/ProcessingSteps'
import {useAutosave, useSaving} from '@/lib/autosave'
import {completeSummaryMarkdown, parseSummaryData, summaryBlocks} from '@/lib/summaryMarkdown'

const Panel = styled.div`
    padding: ${({theme}) => theme.space[3.5]} ${({theme}) => theme.space[5]} ${({theme}) => theme.space[4]};
`

const Centered = styled.div`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[9]} ${({theme}) => theme.space[4]};
    text-align: center;
`

const Title = styled.p`
    margin: 0;
    ${({theme}) => theme.text.heading};
`

const Muted = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.muted};
    overflow-wrap: anywhere;
`

const Running = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.surface};

    > :first-child {
        flex: 1;
        min-width: 0;
    }
`

const Footnote = styled.p`
    margin: ${({theme}) => theme.space[5]} 0 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const hasText = (summary: SummaryResponse | undefined) => !!completeSummaryMarkdown(parseSummaryData(summary?.data)).trim()

interface SummaryPanelProps {
    meetingId: string
    /** The transcript has lines, so there is something to summarize. */
    canWrite: boolean
    /** Writes the summary (the first time, or again after a failure). */
    onWrite: () => void
    /** A run is being started. */
    starting: boolean
}

/**
 * The Summary tab: the post-call pass's steps while it runs; a run in
 * progress with Cancel; a failed run with Try again; Generate summary when
 * there is none; otherwise the summary, editable in place, with the action
 * items it lists. Writing it again is the tab row's.
 */
export function SummaryPanel({meetingId, canWrite, onWrite, starting}: SummaryPanelProps) {
    const job = usePostCallJob(meetingId)
    const summary = useQuery(summaryQuery(meetingId))
    const cancel = useMutation(cancelSummaryMutation(meetingId))

    if (job) {
        return <Panel><ProcessingSteps meetingId={meetingId}/></Panel>
    }
    if (summary.isPending) {
        return <Panel><Centered aria-busy="true"><Spinner delayed/></Centered></Panel>
    }
    if (summary.isError) {
        return (
            <Panel>
                <Centered role="alert">
                    <Title>Couldn’t load the summary</Title>
                    <Muted>{summary.error.message}</Muted>
                    <Button size="sm" onClick={() => void summary.refetch()}>Try again</Button>
                </Centered>
            </Panel>
        )
    }
    const {status, error} = summary.data
    if (isSummaryRunning(status) || starting) {
        return (
            <Panel>
                <Running>
                    <StatusLine status={{key: 'writing', text: 'Writing the summary…', busy: true}}/>
                    <Button
                        size="sm"
                        variant="ghost"
                        pending={cancel.isPending}
                        disabled={starting}
                        onClick={() => cancel.mutate(undefined, {
                            onError: (cause) => toast.error('Couldn’t stop the summary', {description: cause.message}),
                        })}
                    >
                        Cancel
                    </Button>
                </Running>
            </Panel>
        )
    }
    if (status === 'failed' || status === 'error') {
        return (
            <Panel>
                <Centered role="alert">
                    <Title>The summary couldn’t be written</Title>
                    {error && <Muted>{error}</Muted>}
                    <Button size="sm" variant="filled" disabled={!canWrite} onClick={onWrite}>Try again</Button>
                </Centered>
            </Panel>
        )
    }
    if (!hasText(summary.data)) {
        return (
            <Panel>
                <Centered>
                    <Title>No summary yet</Title>
                    <Muted>{canWrite ? 'Protocol writes it from the transcript, on this computer or with the provider you chose.' : 'There’s no transcript to summarize yet.'}</Muted>
                    <Button size="sm" variant="filled" disabled={!canWrite} onClick={onWrite}>Generate summary</Button>
                </Centered>
            </Panel>
        )
    }
    return <WrittenSummary meetingId={meetingId} summary={summary.data}/>
}

/**
 * A written summary in the editor, its action section included as the model
 * wrote it (#218). The editor reads its content once, so it mounts only when
 * the cached summary is the latest, with no edit of it still saving, and
 * mounts again when a new run's summary arrives (keyed by the run's end).
 */
function WrittenSummary({meetingId, summary}: { meetingId: string, summary: SummaryResponse }) {
    const saving = useSaving(`summary:${meetingId}`)
    // As in NotesPanel: the toast outlives the panel, which saves as it unmounts.
    const save = useMutation({
        ...saveSummaryMutation(meetingId),
        onError: (error) => toast.error('Couldn’t save the summary', {description: error.message}),
    })
    const autosave = useAutosave((content: NotesContent) => {
        save.mutate({markdown: content.markdown, summary_json: content.json})
    })

    const editorKey = summary.end ?? summary.start ?? 'summary'
    // The content the editor mounted with, read once per run.
    const [mounted, setMounted] = useState<{ key: string, blocks: unknown[] | null, markdown: string } | null>(null)
    if (!saving && mounted?.key !== editorKey) {
        const data = parseSummaryData(summary.data)
        setMounted({key: editorKey, blocks: summaryBlocks(data), markdown: completeSummaryMarkdown(data)})
    }

    const shown = mounted?.key === editorKey ? mounted : null
    return (
        <Panel>
            {shown
                ? (
                    <NotesEditor
                        key={editorKey}
                        variant="summary"
                        label="Summary"
                        initialBlocks={shown.blocks}
                        initialMarkdown={shown.markdown}
                        onChange={(content) => autosave.schedule(content)}
                    />
                )
                : <Centered aria-busy="true"><Spinner delayed/></Centered>}
            <Footnote>Written from the transcript.</Footnote>
        </Panel>
    )
}
