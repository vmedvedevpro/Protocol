import {type ReactNode, useState} from 'react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {Veil} from '@/components/ui/Veil'
import {tween} from '@/styles/motion'

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
    min-width: 0;
`

const Action = styled.div`
    display: flex;
    flex: none;
`

// What a phase shows (the middle, the action) is keyed by the bar's label: a
// new phase's content rises under a veil as a screen does, the old goes at
// once. The veil is the window's colour, which is behind the bar.
const BodyContent = styled(m.div)`
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    align-items: flex-start;
    min-width: 0;
`

const ActionContent = styled(m.div)`
    position: relative;
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

const arrival = {initial: {y: 4}, animate: {y: 0}, transition: tween('base', 'enter')}
// The phase the bar mounted in shows as it was, so a screen that mounts the
// bar replays nothing.
const still = {initial: false, animate: {y: 0}} as const

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
 * A change of label (Record, Recording) is a new phase: its middle and action
 * arrive under a veil, while the bar and the ring stay mounted.
 */
export function DockedBar({label, ring, children, action}: DockedBarProps) {
    // The label the bar mounted with, until the first change of phase.
    const [mountedWith, setMountedWith] = useState<string | null>(label)
    if (mountedWith !== null && mountedWith !== label) setMountedWith(null)
    const changed = mountedWith === null
    const motion = changed ? arrival : still

    return (
        <Bar role="group" aria-label={label}>
            <RingSlot>{ring}</RingSlot>
            <Body>
                <BodyContent key={label} {...motion}>
                    {children}
                    {changed && <Veil/>}
                </BodyContent>
            </Body>
            {action && (
                <Action>
                    <ActionContent key={label} {...motion}>
                        {action}
                        {changed && <Veil/>}
                    </ActionContent>
                </Action>
            )}
        </Bar>
    )
}
