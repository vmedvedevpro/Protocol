import {CircleNotchIcon} from '@phosphor-icons/react'
import styled, {css, keyframes} from 'styled-components'

const turn = keyframes`
    to {
        transform: rotate(1turn);
    }
`

const appear = keyframes`
    from {
        opacity: 0;
    }
`

// Essential motion: the turn is all that tells a wait from a frozen window,
// so it stays outside MOTION_OK and keeps turning under reduced motion. A
// delayed spinner holds at opacity 0 through the delay, then fades in.
const Turning = styled(CircleNotchIcon)<{ $delayed: boolean }>`
    flex: none;
    /* Centres a text-sized icon on the line when it sits inline. */
    vertical-align: -0.125em;
    animation: ${turn} ${({theme}) => theme.motion.spinner.turn} linear infinite;

    ${({$delayed}) => $delayed && css`
        animation:
            ${turn} ${({theme}) => theme.motion.spinner.turn} linear infinite,
            ${appear} ${({theme}) => theme.motion.duration.base} ${({theme}) => theme.motion.easing.enter}
            ${({theme}) => theme.motion.spinner.delay} both;
    `};
`

interface SpinnerProps {
    /** The text's size by default (`1em`); a button passes the icon size. */
    size?: number | string
    /**
     * Shows after `theme.motion.spinner.delay`: for a spinner standing in for
     * content that usually arrives at once, so a fast load does not flash it.
     */
    delayed?: boolean
}

/**
 * A wait of unknown length: Phosphor's CircleNotch turning in the current
 * colour. Hidden from screen readers; the text beside it, or `aria-busy` on
 * what is waiting, says what the wait is. A wait whose share is known shows
 * a ProgressBar or its percent instead.
 */
export function Spinner({size = '1em', delayed = false}: SpinnerProps) {
    return <Turning size={size} aria-hidden $delayed={delayed}/>
}
