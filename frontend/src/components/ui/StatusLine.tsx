import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {tween} from '@/styles/motion'

/**
 * What a status line says. `key` names the meaning (`downloading`, `ready`);
 * `text` says it; `value` is what changes within that meaning (a percent, a
 * timer), if anything.
 */
export interface Status {
    key: string
    text: string
    value?: string
}

const Line = styled.span`
    display: inline-flex;
    align-items: baseline;
    gap: ${({theme}) => theme.space[1]};
    min-width: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

// A transform needs a box; a plain inline span would ignore it.
const Swap = styled(m.span)`
    display: inline-block;
`

// Figures keep one width, so a climbing percent does not shake the line.
const Value = styled(Swap)`
    font-variant-numeric: tabular-nums;
`

const swap = {
    initial: {opacity: 0, y: 4},
    animate: {opacity: 1, y: 0},
    exit: {opacity: 0, y: -4},
    transition: tween('fast'),
}

/**
 * A one-line status. When its meaning changes the old line leaves upwards
 * and the new one arrives from below (only the fade under reduced motion);
 * within one meaning the value updates where it stands.
 *
 * Only the text is the live region (`role="status"`): screen readers announce
 * a change of meaning, not every tick of the value beside it.
 */
export function StatusLine({status}: { status: Status }) {
    return (
        <Line>
            <span role="status">
                <AnimatePresence mode="wait" initial={false}>
                    <Swap key={status.key} {...swap}>{status.text}</Swap>
                </AnimatePresence>
            </span>
            {/* Keyed like the text, so the two leave and arrive together. */}
            <AnimatePresence mode="wait" initial={false}>
                {status.value !== undefined && <Value key={status.key} {...swap}>{status.value}</Value>}
            </AnimatePresence>
        </Line>
    )
}
