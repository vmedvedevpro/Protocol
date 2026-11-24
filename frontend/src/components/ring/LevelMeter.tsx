import {useEffect, useRef} from 'react'
import styled from 'styled-components'
import {type LevelFeed, useAudioLevel} from '@/api/audio'
import {MOTION_OK} from '@/styles/motion'

const BARS = 5
// Bars rest at 3 of their 16 px, as in the design, so a silent meter still
// shows where it is.
const REST = 3 / 16
// The bars fall back to rest when no sample came for this long: native stops
// sending when a recording stops or a device goes away, and the meter must not
// freeze mid-word. Samples come every 40 to 80 ms.
const SILENCE_MS = 300

const Bars = styled.span`
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[0.5]};
    height: ${({theme}) => theme.sizes.meter.height};
`

// Each bar is always full height and scales: a transform moves no layout.
// The transition smooths the 12 to 25 samples a second into motion.
const Bar = styled.span`
    width: ${({theme}) => theme.sizes.meter.bar};
    height: 100%;
    border-radius: ${({theme}) => theme.radii.pill};
    background: currentColor;
    transform: scaleY(${REST});

    ${MOTION_OK} {
        transition: transform ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.enter};
    }
`

type BarElements = (HTMLSpanElement | null)[]

/**
 * Writes one sample into the bars. As in the design's mock, each bar shows its
 * own share of the level, from 35 % to all of it, swinging at its own pace, so
 * the meter reads as a voice rather than one block. `seed` keeps two meters
 * side by side from moving in step.
 */
function drawLevel(bars: BarElements, level: number, seed: number) {
    const t = performance.now() / 1000
    bars.forEach((bar, i) => {
        if (!bar) return
        const share = 0.35 + 0.65 * Math.abs(Math.sin(t * (5 + i * 1.7) + seed + i))
        bar.style.transform = `scaleY(${REST + (1 - REST) * level * share})`
    })
}

interface LevelMeterProps {
    /** Where the bars read the level; null keeps them at rest (paused, muted). */
    level: LevelFeed | null
    /**
     * Names the meter where it stands alone, as the old meters did
     * ("Microphone audio level"). Without it the meter is hidden from
     * assistive technology, for a control that names it already.
     */
    label?: string
    className?: string
}

/**
 * Five small bars in the current text colour, for the microphone or the
 * computer audio. Samples go straight to the bars' transforms, never through
 * React state.
 */
export function LevelMeter({level, label, className}: LevelMeterProps) {
    const bars = useRef<BarElements>([])
    const silence = useRef<ReturnType<typeof setTimeout>>(undefined)
    const seed = level?.kind === 'recording' && level.source === 'system' ? 1.7 : 0.3
    const listening = level !== null

    useAudioLevel(level, (value) => {
        drawLevel(bars.current, value, seed)
        clearTimeout(silence.current)
        silence.current = setTimeout(() => drawLevel(bars.current, 0, seed), SILENCE_MS)
    })

    // A meter that stops listening (paused) settles at rest.
    useEffect(() => {
        if (listening) return
        clearTimeout(silence.current)
        drawLevel(bars.current, 0, 0)
    }, [listening])

    useEffect(() => () => clearTimeout(silence.current), [])

    return (
        <Bars {...(label ? {role: 'img', 'aria-label': label} : {'aria-hidden': true})} className={className}>
            {Array.from({length: BARS}, (_, i) => (
                <Bar key={i} ref={(bar) => {
                    bars.current[i] = bar
                }}/>
            ))}
        </Bars>
    )
}
