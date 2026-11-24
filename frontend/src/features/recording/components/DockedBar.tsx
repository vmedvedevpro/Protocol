import type {ReactNode} from 'react'
import styled from 'styled-components'

const Bar = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    height: ${({theme}) => theme.sizes.bar.dock};
    padding: 0 ${({theme}) => theme.space[3]} 0 ${({theme}) => theme.space[1]};
`

const RingSlot = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.bar.dockRing};
    height: ${({theme}) => theme.sizes.bar.dockRing};
`

const Body = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
`

const Action = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

export interface DockedBarProps {
    /** Names the group: `Record` while idle, `Recording` during one. */
    label: string
    /** The ring at the start: idle and greyed, or following the level. */
    ring: ReactNode
    /** The middle: a status ("Ready to record", the timer) over the inputs. */
    children: ReactNode
    /** At the end: Record or Stop with its shortcut. */
    action?: ReactNode
}

/**
 * The bar docked at the bottom of the window, as the design draws it on the
 * meetings and the recording screen: the ring, what is happening, and the
 * one action. Layout only; the recording (#112) decides what goes in it.
 */
export function DockedBar({label, ring, children, action}: DockedBarProps) {
    return (
        <Bar role="group" aria-label={label}>
            <RingSlot>{ring}</RingSlot>
            <Body>{children}</Body>
            {action && <Action>{action}</Action>}
        </Bar>
    )
}
