import * as m from 'motion/react-m'
import styled from 'styled-components'
import {type DurationName, tween} from '@/styles/motion'

const Cover = styled(m.span)<{ $outset: number }>`
    position: absolute;
    inset: ${({$outset}) => -$outset}px;
    z-index: 1;
    border-radius: inherit;
    pointer-events: none;
    background: var(--surface, ${({theme}) => theme.colors.bg});
`

export interface VeilProps {
    /** `base` for views and rows, `fast` for a status change. */
    duration?: DurationName
    /** Pixels past the padding box, so the veil covers the element's border too. */
    outset?: number
}

/**
 * How text arrives and leaves. Text never fades itself: under an opacity
 * below 1 Chromium draws it without subpixel antialiasing and draws it again
 * when the fade ends, a visible blink. A veil in the colour behind it fades
 * out over it instead, and only the veil is composited.
 *
 * Put it last inside the `m` element that arrives (its 4 px rise stays on
 * that element), which needs `position: relative`. The colour is
 * `--surface`, which a surface sets on the element inside it whose content
 * swaps (the window's background otherwise). Under AnimatePresence the veil
 * covers a leaving element again before it goes: the same in reverse.
 */
export function Veil({duration = 'base', outset = 0}: VeilProps) {
    return (
        <Cover
            aria-hidden="true"
            $outset={outset}
            initial={{opacity: 1}}
            animate={{opacity: 0, transition: tween(duration, 'enter')}}
            exit={{opacity: 1, transition: tween(duration, 'exit')}}
        />
    )
}
