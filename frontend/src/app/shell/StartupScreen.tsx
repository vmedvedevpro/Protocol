import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {Button} from '@/components/ui/Button'
import {type Status, StatusLine} from '@/components/ui/StatusLine'
import {Veil} from '@/components/ui/Veil'
import {tween} from '@/styles/motion'
import {Screen} from '@/components/screen/Screen'
import type {StartupPhase} from './startup'

type Checking = Exclude<StartupPhase, 'firstLaunch' | 'ready'>

// `slow` is still waiting on the same read, so its spinner keeps turning.
const STATUS: Record<Checking, Status> = {
    checking: {key: 'checking', text: 'Checking setup…', busy: true},
    slow: {key: 'slow', text: 'Setup status is taking longer than expected.', busy: true},
    failed: {key: 'failed', text: 'Unable to check setup status. Please retry.'},
    databaseFailed: {key: 'databaseFailed', text: 'Unable to set up the meetings database. Please retry.'},
}

const Centre = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[6]};
    text-align: center;
`

const Title = styled.h1`
    ${({theme}) => theme.text.title};
`

const Retry = styled(m.div)`
    position: relative;
    margin-top: ${({theme}) => theme.space[2]};
`

/** "Checking setup…", and Retry once the check failed or stalls. */
export function StartupScreen({phase, onRetry}: { phase: Checking, onRetry: () => void }) {
    return (
        <Screen>
            <Centre>
                <Title>Protocol</Title>
                <StatusLine status={STATUS[phase]}/>
                <AnimatePresence>
                    {phase !== 'checking' && (
                        <Retry initial={{y: 4}} animate={{y: 0}} transition={tween('base')}>
                            <Button onClick={onRetry}>Retry</Button>
                            <Veil/>
                        </Retry>
                    )}
                </AnimatePresence>
            </Centre>
        </Screen>
    )
}
