import type {ReactNode} from 'react'
import {CheckCircleIcon, CircleIcon, WarningCircleIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {type PostCallJob, type PostCallStep, usePostCallJob} from '@/api/postCall'
import {Spinner} from '@/components/ui/Spinner'
import {Veil} from '@/components/ui/Veil'
import {VisuallyHidden} from '@/components/ui/VisuallyHidden'
import {tween} from '@/styles/motion'
import {postCallStatusText, postCallStepLabel, useRemainingText} from './progress'

const Card = styled(m.div)`
    position: relative;
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2.5]};
`

const List = styled.ol`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2.5]};
    margin: 0;
    padding: ${({theme}) => theme.space[3.5]} ${({theme}) => theme.space[3.5]} ${({theme}) => theme.space[3]};
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.surface};
    list-style: none;
    ${({theme}) => theme.text.body};
`

const Item = styled.li<{ $pending: boolean }>`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2.5]};
    color: ${({theme, $pending}) => ($pending ? theme.colors.muted : theme.colors.text)};
    transition: color ${({theme}) => theme.motion.duration.base} ${({theme}) => theme.motion.easing.standard};
`

// One icon's box, so the label never moves while the icon swaps.
const Mark = styled.span`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.meter.icon};
    height: ${({theme}) => theme.sizes.meter.icon};
`

const Icon = styled(m.span)<{ $faint?: boolean }>`
    display: inline-flex;
    color: ${({theme, $faint}) => ($faint ? theme.colors.border : 'inherit')};
`

const Label = styled.span`
    flex: 1;
    min-width: 0;
`

const Remaining = styled.span`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Note = styled.p`
    margin: 0 ${({theme}) => theme.space[0.5]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

type StepState = 'done' | 'running' | 'failed' | 'pending'

const ICONS: Record<StepState, ReactNode> = {
    done: <CheckCircleIcon aria-hidden/>,
    running: <Spinner/>,
    failed: <WarningCircleIcon aria-hidden/>,
    pending: <CircleIcon aria-hidden/>,
}

const SPOKEN: Record<StepState, string> = {done: 'done', running: 'in progress', failed: 'failed', pending: 'to do'}

function stateOf(job: PostCallJob, step: PostCallStep): StepState {
    const at = job.steps.indexOf(job.step)
    const index = job.steps.indexOf(step)
    if (index < at) return 'done'
    if (index > at || job.state === 'queued') return 'pending'
    return job.state === 'failed' ? 'failed' : 'running'
}

function Step({state, label, remaining}: { state: StepState; label: string; remaining?: string | null }) {
    return (
        <Item $pending={state === 'pending'}>
            <Mark>
                {/* A step's state is a status change: its icon swaps over `fast`. */}
                <AnimatePresence mode="wait" initial={false}>
                    <Icon
                        key={state}
                        $faint={state === 'pending'}
                        initial={{opacity: 0, y: 4}}
                        animate={{opacity: 1, y: 0}}
                        exit={{opacity: 0, y: -4}}
                        transition={tween('fast')}
                    >
                        {ICONS[state]}
                    </Icon>
                </AnimatePresence>
            </Mark>
            <Label>
                {label}
                <VisuallyHidden>{`, ${SPOKEN[state]}`}</VisuallyHidden>
            </Label>
            {remaining && <Remaining>{remaining}</Remaining>}
        </Item>
    )
}

interface ProcessingStepsProps {
    meetingId: string
    className?: string
}

/**
 * The steps of a meeting's post-call pass, where its summary will be: the
 * recording saved, then each step done, running (with the time left when
 * known), failed or still to do. Nothing once the pass has ended.
 */
export function ProcessingSteps({meetingId, className}: ProcessingStepsProps) {
    const job = usePostCallJob(meetingId)
    const remaining = useRemainingText(job)
    if (!job) return null
    return (
        <Card
            className={className}
            initial={{y: 4}}
            animate={{y: 0}}
            transition={tween('base', 'enter')}
        >
            <List aria-label="Processing steps">
                <Step state="done" label="Recording saved"/>
                {job.steps.map((step) => {
                    const state = stateOf(job, step)
                    return (
                        <Step
                            key={step}
                            state={state}
                            label={state === 'failed' ? postCallStatusText(job) : postCallStepLabel(step)}
                            remaining={state === 'running' ? remaining : null}
                        />
                    )
                })}
            </List>
            <Note>You can close the window; Protocol finishes in the background.</Note>
            <Veil/>
        </Card>
    )
}
