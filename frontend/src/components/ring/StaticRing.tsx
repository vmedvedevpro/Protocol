import type {CSSProperties} from 'react'
import styled from 'styled-components'
import {RING_MODES, type RingMode} from './ringMotion'

// The logo's flat ring, which the design draws where the glow would blur
// (icons of 32 px and less): a ring 64 % of the box wide, its stroke a tenth of
// the box, never thinner than 1.6 px, painted with the shader's three stops.
const DIAMETER = 0.64
const STROKE = 0.1
const MIN_STROKE_PX = 1.6
// The mask's soft inner edge, so the stroke is antialiased.
const FEATHER_PX = 0.8
// The shader dims a grey ring by this share of its light (1 - 0.35 × grey).
const GREY_DIM = 0.35

const Shape = styled.span`
    position: absolute;
    inset: ${((1 - DIAMETER) * 50).toFixed(1)}%;
    border-radius: 50%;
    background: ${({theme}) => `conic-gradient(from 200deg, ${theme.ring.violet}, ${theme.ring.blue} 40%, ${theme.ring.cyan} 70%, ${theme.ring.violet})`};
    /* black is the mask's opaque part, not a colour on screen */
    mask: radial-gradient(farthest-side, transparent calc(100% - var(--stroke)), black calc(100% - var(--stroke) + ${FEATHER_PX}px));
    transition-property: opacity, filter;
    transition-duration: ${({theme}) => theme.motion.duration.base};
    transition-timing-function: ${({theme}) => theme.motion.easing.standard};
`

interface StaticRingProps {
    mode: RingMode
    /** The box it sits in, in CSS pixels; the ring is 64 % of it. */
    size: number
}

/**
 * The ring without WebGL: a still gradient ring, greyed as the shader greys
 * each mode. Ring shows it when WebGL is unavailable or its context is lost.
 * It fills the nearest positioned ancestor.
 */
export function StaticRing({mode, size}: StaticRingProps) {
    const mono = RING_MODES[mode].mono
    const style = {
        '--stroke': `${Math.max(MIN_STROKE_PX, size * STROKE)}px`,
        filter: `grayscale(${mono})`,
        opacity: 1 - GREY_DIM * mono,
    } as CSSProperties
    return <Shape aria-hidden="true" data-testid="static-ring" style={style}/>
}
