import styled from 'styled-components'
import {MOTION_OK} from '@/styles/motion'

const Track = styled.div`
    height: ${({theme}) => theme.sizes.progress};
    overflow: hidden;
    border-radius: ${({theme}) => theme.radii.xs};
    background: ${({theme}) => theme.colors.border};
`

// The fill is full width, scaled from the left: a transform, so a ticking
// value never lays the window out again. Each step glides over `base`.
const Fill = styled.div`
    height: 100%;
    border-radius: inherit;
    background: ${({theme}) => theme.colors.text};
    transform-origin: left;

    ${MOTION_OK} {
        transition: transform ${({theme}) => theme.motion.duration.base} ${({theme}) => theme.motion.easing.standard};
    }
`

interface ProgressBarProps {
    /** The accessible name: what is progressing, such as "Downloading Parakeet". */
    label: string
    /** Done so far, from 0 to `max`. */
    value: number
    max?: number
}

/** How far a download or a step has got. Show the number beside it in text when it matters. */
export function ProgressBar({label, value, max = 100}: ProgressBarProps) {
    const done = Math.min(Math.max(value, 0), max)
    return (
        <Track role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={done}>
            {/* An inline style, not a styled prop: a new value must not make a new class. */}
            <Fill style={{transform: `scaleX(${max > 0 ? done / max : 0})`}}/>
        </Track>
    )
}
