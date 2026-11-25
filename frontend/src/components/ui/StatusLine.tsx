import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {Spinner} from './Spinner'
import {statusSwap as swap} from '@/styles/motion'
import {Veil} from './Veil'
import {VisuallyHidden} from './VisuallyHidden'

/**
 * What a status line says. `key` names the meaning (`downloading`, `ready`);
 * `text` says it; `value` is what changes within that meaning (a percent, a
 * timer), if anything. `busy` marks a wait of unknown length, such as
 * "Checking for updates…": a spinner turns before the text, since static
 * text alone would look frozen.
 */
export interface Status {
    key: string
    text: string
    value?: string
    busy?: boolean
}

const Line = styled.span`
    position: relative;
    display: inline-flex;
    min-width: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

// A transform needs a box; a plain inline span would ignore it.
const Swap = styled(m.span)`
    position: relative;
    display: inline-block;
`

const Busy = styled.span`
    margin-right: ${({theme}) => theme.space[1]};
`

// Figures keep one width, so a climbing percent does not shake the line.
const Value = styled.span`
    margin-left: ${({theme}) => theme.space[1]};
    font-variant-numeric: tabular-nums;
`

/**
 * A one-line status. When its meaning changes the old line leaves upwards
 * and the new one arrives from below, each under a veil (only the veil
 * under reduced motion); within one meaning the value updates where it
 * stands.
 *
 * The spinner, the text and the value are one keyed unit: they leave
 * together and the next unit arrives only once the last has left, so what
 * stays on screen never moves. Separate presences for text and value let a
 * new value arrive beside the leaving text and jump when the text swapped.
 * A status's `busy` belongs to its meaning (its key), so a spinner never
 * comes or goes under a text that stays.
 *
 * The live region (`role="status"`) is a hidden copy of the text that stays
 * mounted, so a change of meaning is announced (a new region is not) and a
 * ticking value is not.
 */
export function StatusLine({status}: { status: Status }) {
    return (
        <Line>
            <VisuallyHidden role="status">{status.text}</VisuallyHidden>
            <AnimatePresence mode="wait" initial={false}>
                <Swap key={status.key} {...swap}>
                    <span aria-hidden>
                        {status.busy && <Busy><Spinner/></Busy>}
                        {status.text}
                    </span>
                    {status.value !== undefined && <Value>{status.value}</Value>}
                    <Veil duration="fast"/>
                </Swap>
            </AnimatePresence>
        </Line>
    )
}
