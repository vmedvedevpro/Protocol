import {WarningCircleIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {type PostCallJob, postCallControls, usePostCallJob} from '@/api/postCall'
import {Button} from '@/components/ui/Button'
import {ProgressBar} from '@/components/ui/ProgressBar'
import {StatusLine} from '@/components/ui/StatusLine'
import {tween} from '@/styles/motion'
import {postCallProgress, postCallSkipLabel, postCallStatusText, useRemainingText} from './progress'

const Strip = styled(m.div)`
    flex: none;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[2.5]};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.surface};
`

const Content = styled(m.div)`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2]};
`

const Row = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    min-height: ${({theme}) => theme.sizes.control.sm};
`

const Grow = styled.div`
    display: flex;
    flex: 1;
    min-width: 0;
`

const Failure = styled.div`
    display: flex;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[2]};
    ${({theme}) => theme.text.small};

    > svg {
        flex: none;
        margin-top: ${({theme}) => theme.space[0.5]};
    }
`

const FailureText = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[0.5]};
    min-width: 0;
`

const FailureTitle = styled.span`
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

const FailureReason = styled.span`
    overflow-wrap: anywhere;
    color: ${({theme}) => theme.colors.muted};
`

const Actions = styled.div`
    display: flex;
    justify-content: flex-end;
    gap: ${({theme}) => theme.space[1.5]};
`

function Running({job}: { job: PostCallJob }) {
    const remaining = useRemainingText(job)
    const cancelling = job.state === 'cancelling'
    return (
        <>
            <Row>
                <Grow>
                    <StatusLine
                        status={{
                            // The meaning: a new step, or the wait turning into a cancel.
                            key: `${job.state}:${job.step}`,
                            text: postCallStatusText(job),
                            value: remaining ? `· ${remaining}` : undefined,
                            busy: true,
                        }}
                    />
                </Grow>
                {job.state !== 'queued' && (
                    <Button size="sm" variant="ghost" pending={cancelling} onClick={() => postCallControls.cancel(job.meetingId)}>
                        Cancel
                    </Button>
                )}
            </Row>
            <ProgressBar label="Processing the meeting" value={Math.round(postCallProgress(job) * 100)}/>
        </>
    )
}

function Failed({job}: { job: PostCallJob }) {
    return (
        <>
            <Failure role="alert">
                <WarningCircleIcon aria-hidden/>
                <FailureText>
                    <FailureTitle>{postCallStatusText(job)}</FailureTitle>
                    {job.error && <FailureReason>{job.error}</FailureReason>}
                </FailureText>
            </Failure>
            <Actions>
                <Button size="sm" variant="ghost" onClick={() => postCallControls.skip(job.meetingId)}>
                    {postCallSkipLabel(job.step)}
                </Button>
                <Button size="sm" onClick={() => postCallControls.retry(job.meetingId)}>Retry</Button>
            </Actions>
        </>
    )
}

interface ProcessingStatusProps {
    meetingId: string
    className?: string
}

/**
 * The strip under a meeting's header while its post-call pass runs: what
 * runs and roughly how long is left, the whole pass's progress, and Cancel;
 * after a failure, what failed with Retry and Skip. Nothing once the pass
 * has ended, so the meeting screen can render it unconditionally.
 */
export function ProcessingStatus({meetingId, className}: ProcessingStatusProps) {
    const job = usePostCallJob(meetingId)
    const failed = job?.state === 'failed'
    return (
        <AnimatePresence initial={false}>
            {job && (
                <Strip
                    key="processing"
                    className={className}
                    initial={{opacity: 0, y: 4}}
                    animate={{opacity: 1, y: 0}}
                    exit={{opacity: 0, transition: tween('base', 'exit')}}
                    transition={tween('base', 'enter')}
                >
                    {/* A failure, or Retry after one, swaps the content as a status change. */}
                    <AnimatePresence mode="wait" initial={false}>
                        <Content
                            key={failed ? 'failed' : 'running'}
                            initial={{opacity: 0, y: 4}}
                            animate={{opacity: 1, y: 0}}
                            exit={{opacity: 0, y: -4}}
                            transition={tween('fast')}
                        >
                            {failed ? <Failed job={job}/> : <Running job={job}/>}
                        </Content>
                    </AnimatePresence>
                </Strip>
            )}
        </AnimatePresence>
    )
}
