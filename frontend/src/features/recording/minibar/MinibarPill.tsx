import {type FocusEvent, useLayoutEffect, useRef, useState} from 'react'
import {ArrowsOutSimpleIcon, PauseIcon, PlayIcon, StopIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {css, useTheme} from 'styled-components'
import type {AudioSource} from '@/api/audio'
import type {LevelWarning} from '@/components/ring/levelAdvice'
import {Ring} from '@/components/ring/Ring'
import {SourceMeter} from '@/components/ring/SourceMeter'
import {Spinner} from '@/components/ui/Spinner'
import {Veil} from '@/components/ui/Veil'
import {colorTransition, focusRing, px} from '@/components/ui/styles'
import {ICON_DEFAULTS} from '@/styles/icons'
import {MOTION_OK, SCALE_FROM, statusSwap, tween} from '@/styles/motion'
import {formatTimer} from '../store/session'

/**
 * Where the recording is, as the minibar shows it: `finishing` from Stop
 * until native closes the bar.
 */
export type MinibarPhase = 'recording' | 'paused' | 'finishing'

// The pill fills the window (minibar.rs), which follows its width, from its
// left edge: opening it moves neither the ring nor Stop, and what it reveals
// arrives to their right. No shadow: the window would cut it off.
const Pill = styled.div`
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    height: ${({theme}) => theme.sizes.minibar.height};
    padding: 0 ${({theme}) => theme.space[1.5]} 0 ${({theme}) => theme.space[0.5]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.pill};
    --surface: ${({theme}) => theme.colors.raised};
    background: var(--surface);
    color: ${({theme}) => theme.colors.text};
    white-space: nowrap;
    cursor: grab;
    user-select: none;
`

const press = css`
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    ${MOTION_OK} {
        transition-property: color, background-color, transform;

        &:active {
            transform: scale(${SCALE_FROM});
        }
    }
`

// The ring is the pause button, as on the recording bar.
const RingButton = styled.button`
    display: flex;
    flex: none;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    ${press};
`

const Clock = styled.span`
    display: flex;
    flex-direction: column;
    min-width: ${({theme}) => theme.sizes.minibar.clock};
`

const Time = styled.span`
    font-family: ${({theme}) => theme.fonts.mono};
    ${({theme}) => theme.text.timer};
    font-variant-numeric: tabular-nums;
`

const Status = styled.span`
    ${({theme}) => theme.text.caption};
    color: ${({theme}) => theme.colors.muted};
`

// A transform needs a box; a plain inline span would ignore it.
const Swap = styled(m.span)`
    position: relative;
    display: inline-block;
`

const Stop = styled.button`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    gap: ${({theme}) => theme.space[1.5]};
    min-width: ${({theme}) => theme.sizes.control.md};
    height: ${({theme}) => theme.sizes.control.md};
    padding: 0 ${({theme}) => theme.space[2.5]};
    border: 0;
    border-radius: ${({theme}) => theme.radii.pill};
    /* The colour behind the Stop label's veil follows the hover. */
    --surface: ${({theme}) => theme.colors.surface};
    background: var(--surface);
    color: ${({theme}) => theme.colors.text};
    ${({theme}) => theme.text.label};
    ${press};

    &:hover {
        --surface: ${({theme}) => theme.colors.border};
    }
`

const StopLabel = styled(m.span)`
    position: relative;
    padding-right: ${({theme}) => theme.space[1]};
`

const Waiting = styled.span`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.control.md};
    height: ${({theme}) => theme.sizes.control.md};
`

// What hover or keyboard focus reveals, one flex item that fades in.
const More = styled(m.span)`
    position: relative;
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
`

const Divider = styled.span`
    flex: none;
    width: 1px;
    height: ${({theme}) => theme.space[6]};
    background: ${({theme}) => theme.colors.border};
`

const RoundButton = styled.button`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.control.md};
    height: ${({theme}) => theme.sizes.control.md};
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: ${({theme}) => theme.colors.muted};
    ${press};

    &:hover {
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.text};
    }
`

// What the open pill shows arrives 4 px from the left under a veil and goes
// at once as it closes: text never fades (Veil).
const reveal = {
    initial: {x: -4},
    animate: {x: 0},
    transition: tween('base', 'enter'),
}

// Chromium's :focus-visible; a selector engine without it (jsdom's, in
// some versions) counts no focus as the keyboard's.
function isKeyboardFocus(element: Element) {
    try {
        return element.matches(':focus-visible')
    } catch {
        return false
    }
}

/**
 * Open while the pointer is over the pill or the keyboard's focus is in it.
 * A click focuses a button too, but does not hold the pill open after the
 * pointer leaves.
 */
function useOpenOnHover(pointerLeftWindow: number) {
    const [hovered, setHovered] = useState(false)
    const [focused, setFocused] = useState(false)
    // Native's word that the pointer left the window, where the webview
    // reported no pointerleave (MinibarPage): each new count ends the hover.
    const [leftSeen, setLeftSeen] = useState(pointerLeftWindow)
    if (pointerLeftWindow !== leftSeen) {
        setLeftSeen(pointerLeftWindow)
        setHovered(false)
    }
    return {
        open: hovered || focused,
        handlers: {
            onPointerEnter: () => setHovered(true),
            // After native's leave (Linux) WebKitGTK still thinks the pointer
            // is inside and sends no pointerenter when it comes back; it
            // moves over the pill, though.
            onPointerMove: () => setHovered(true),
            onPointerLeave: () => setHovered(false),
            onFocus: (event: FocusEvent<HTMLElement>) => setFocused(isKeyboardFocus(event.target)),
            onBlur: (event: FocusEvent<HTMLElement>) => {
                // Null when the window itself loses focus.
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
            },
        },
    }
}

export interface MinibarPillProps {
    phase: MinibarPhase
    /** Recorded so far, pauses left out; null until native answers. */
    seconds: number | null
    muted: Record<AudioSource, boolean>
    /** Level advice on computer audio (`useSystemAudioWarning`). */
    warning?: LevelWarning | null
    /** A command that just failed, said in the status's place. */
    failure?: string | null
    /** Holds the pill open, as hover does (stories). */
    open?: boolean
    /** The shortcut that stops, for `aria-keyshortcuts` (`Control+R`, `Meta+R`). */
    stopKeys?: string
    onTogglePause: () => void
    onToggleMute: (source: AudioSource) => void
    onStop: () => void
    onBackToWindow: () => void
    /** A press on the pill outside its buttons: the window follows the pointer. */
    onDragStart: () => void
    /** The pill's width in CSS pixels, rounded up, on mount and on every change. */
    onWidthChange?: (width: number) => void
    /**
     * Counts the times native saw the pointer leave the window; each new
     * count ends the hover (Linux, where the webview does not say).
     */
    pointerLeftWindow?: number
}

/**
 * The minibar: the ring (pause), the timer over what is happening, and
 * Stop. Hover or keyboard focus reveals the microphone and computer audio
 * (a click mutes), Pause and Back to the full window. From Stop on the pill
 * stays closed and a spinner stands where Stop was. No tooltips: the window
 * is the pill's height and would clip them; every button has its name.
 */
export function MinibarPill({
    phase,
    seconds,
    muted,
    warning = null,
    failure = null,
    open: held = false,
    stopKeys,
    onTogglePause,
    onToggleMute,
    onStop,
    onBackToWindow,
    onDragStart,
    onWidthChange,
    pointerLeftWindow = 0,
}: MinibarPillProps) {
    const theme = useTheme()
    const pill = useRef<HTMLDivElement>(null)
    const hover = useOpenOnHover(pointerLeftWindow)
    const finishing = phase === 'finishing'
    const paused = phase === 'paused'
    const open = !finishing && (held || hover.open)
    const ringSize = px(theme.sizes.minibar.ring)
    const pauseLabel = paused ? 'Resume recording' : 'Pause recording'
    const status = failure ?? (finishing ? 'Finishing…' : paused ? 'Paused' : 'Recording')

    // Opening, closing and a longer status change the width; the observer
    // reports the first one too.
    useLayoutEffect(() => {
        const element = pill.current
        if (!element || !onWidthChange) return
        const observer = new ResizeObserver(() => onWidthChange(Math.ceil(element.getBoundingClientRect().width)))
        observer.observe(element)
        return () => observer.disconnect()
    }, [onWidthChange])

    return (
        <Pill
            ref={pill}
            role="group"
            aria-label="Recording controls"
            {...hover.handlers}
            onMouseDown={(event) => {
                if (event.button !== 0 || (event.target as Element).closest('button')) return
                // No text selection and no focus change: the press moves the window.
                event.preventDefault()
                onDragStart()
            }}
        >
            {finishing ? (
                <Ring mode="paused" size={ringSize}/>
            ) : (
                <RingButton type="button" aria-label={pauseLabel} aria-keyshortcuts="Space" onClick={onTogglePause}>
                    <Ring mode={paused ? 'paused' : 'rec'} size={ringSize} level={{kind: 'recording', source: 'both'}}/>
                </RingButton>
            )}
            <Clock>
                <Time role="timer" aria-label="Recording time">{seconds === null ? '–:––' : formatTimer(seconds)}</Time>
                <Status role="status">
                    <AnimatePresence mode="wait" initial={false}>
                        <Swap key={status} {...statusSwap}>{status}<Veil duration="fast"/></Swap>
                    </AnimatePresence>
                </Status>
            </Clock>
            {finishing ? (
                <Waiting><Spinner size={ICON_DEFAULTS.size}/></Waiting>
            ) : (
                <Stop type="button" aria-label="Stop and save" aria-keyshortcuts={stopKeys} onClick={onStop}>
                    <StopIcon size={theme.sizes.meter.icon} weight="fill" aria-hidden/>
                    {open && <StopLabel {...reveal}>Stop<Veil/></StopLabel>}
                </Stop>
            )}
            {open && (
                <More {...reveal}>
                        <Divider aria-hidden/>
                        <SourceMeter
                            source="mic"
                            muted={muted.mic}
                            level={paused ? null : {kind: 'recording', source: 'mic'}}
                            tooltip={false}
                            onToggle={() => onToggleMute('mic')}
                        />
                        <SourceMeter
                            source="system"
                            muted={muted.system}
                            level={paused ? null : {kind: 'recording', source: 'system'}}
                            warning={warning}
                            tooltip={false}
                            onToggle={() => onToggleMute('system')}
                        />
                        <Divider aria-hidden/>
                        <RoundButton type="button" aria-label={pauseLabel} onClick={onTogglePause}>
                            {paused ? <PlayIcon size={theme.sizes.meter.icon} aria-hidden/> : <PauseIcon size={theme.sizes.meter.icon} aria-hidden/>}
                        </RoundButton>
                        <RoundButton type="button" aria-label="Back to the full window" onClick={onBackToWindow}>
                            <ArrowsOutSimpleIcon size={theme.sizes.meter.icon} aria-hidden/>
                        </RoundButton>
                        <Veil/>
                    </More>
                )}
        </Pill>
    )
}
