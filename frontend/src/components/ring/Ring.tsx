import {type CSSProperties, useCallback, useLayoutEffect, useRef, useState} from 'react'
import styled, {useTheme} from 'styled-components'
import {type LevelFeed, useAudioLevel} from '@/api/audio'
import {type RingInputs, type RingLoop, startRingLoop} from './ringLoop'
import type {RingMode} from './ringMotion'
import {StaticRing} from './StaticRing'

export type {RingMode} from './ringMotion'

const Root = styled.span`
    position: relative;
    display: inline-block;
    flex: none;
    width: var(--ring-size);
    height: var(--ring-size);
`

const Canvas = styled.canvas<{ $off: boolean }>`
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    visibility: ${({$off}) => ($off ? 'hidden' : 'visible')};
`

interface RingProps {
    mode: RingMode
    /** Width and height in CSS pixels. */
    size: number
    /**
     * What the edge follows in `rec` and `test`: the recording
     * (`{kind: 'recording', source: 'both'}`) or the device preview. Without
     * it the edge stays calm. The other modes do not listen.
     */
    level?: LevelFeed | null
    className?: string
}

/**
 * The glowing ring of the design, the window's only colored element: WebGL,
 * one frame loop per ring, levels from native events straight into the loop,
 * never through React state. Decorative: the button around it carries the
 * label. Without WebGL it shows StaticRing.
 */
export function Ring({mode, size, level = null, className}: RingProps) {
    const theme = useTheme()
    const [webgl, setWebgl] = useState(true)
    const loop = useRef<RingLoop | null>(null)
    const latest = useRef<RingInputs>({mode, size, palette: theme.ring})

    // The loop belongs to the canvas: created when it mounts, stopped when it
    // unmounts. Later props reach it through update().
    const attach = useCallback((canvas: HTMLCanvasElement | null) => {
        if (!canvas) return
        const started = startRingLoop(canvas, latest.current, setWebgl)
        if (!started) {
            setWebgl(false)
            return
        }
        loop.current = started
        return () => {
            started.stop()
            loop.current = null
        }
    }, [])

    useLayoutEffect(() => {
        latest.current = {mode, size, palette: theme.ring}
        loop.current?.update(latest.current)
    }, [mode, size, theme.ring])

    useAudioLevel(mode === 'rec' || mode === 'test' ? level : null, (heard) => loop.current?.hear(heard))

    return (
        <Root aria-hidden="true" className={className} style={{'--ring-size': `${size}px`} as CSSProperties}>
            <Canvas ref={attach} $off={!webgl}/>
            {!webgl && <StaticRing mode={mode} size={size}/>}
        </Root>
    )
}
