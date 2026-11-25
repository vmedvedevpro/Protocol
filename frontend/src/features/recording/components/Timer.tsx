import {useEffect, useState} from 'react'
import styled from 'styled-components'
import {clockSeconds, formatTimer, useSessionStore} from '../store/session'

const Time = styled.span`
    font-family: ${({theme}) => theme.fonts.mono};
    ${({theme}) => theme.text.timer};
    font-variant-numeric: tabular-nums;
`

/**
 * The recording's time, pauses left out. It renders once a second while
 * the recording runs and holds still while paused; native's own timer
 * corrects it on every pause, resume and sync.
 */
export function Timer() {
    const phase = useSessionStore((state) => state.phase)
    const clock = useSessionStore((state) => state.clock)
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (phase !== 'recording') return
        const tick = setInterval(() => setNow(Date.now()), 1_000)
        return () => clearInterval(tick)
    }, [phase, clock])

    // A clock newer than the last tick (a resume, a sync) counts from its own moment.
    return <Time role="timer" aria-label="Recording time">{formatTimer(clockSeconds({phase, clock}, Math.max(now, clock.at)))}</Time>
}
