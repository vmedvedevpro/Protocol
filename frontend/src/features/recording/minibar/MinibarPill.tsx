import {type FocusEvent, useState} from 'react'
import {ArrowsOutSimpleIcon, PauseIcon, PlayIcon, StopIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {css, useTheme} from 'styled-components'
import type {AudioSource} from '@/api/audio'
import type {LevelWarning} from '@/components/ring/levelAdvice'
import {Ring} from '@/components/ring/Ring'
import {SourceMeter} from '@/components/ring/SourceMeter'
import {Spinner} from '@/components/ui/Spinner'
import {colorTransition, focusRing, px} from '@/components/ui/styles'
import {ICON_DEFAULTS} from '@/styles/icons'
import {MOTION_OK, SCALE_FROM, tween} from '@/styles/motion'
import {formatTimer} from '../store/session'

/**
 * Where the recording is, as the minibar shows it: `finishing` from Stop
 * until native closes the bar.
 */
export type MinibarPhase = 'recording' | 'paused' | 'finishing'

// The pill fills the window (minibar.rs) from its left edge, so opening it
// moves neither the ring nor Stop: what it reveals arrives to their right.
// No shadow: the window is the pill's size and would cut it off.
const Pill = styled.div`
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    height: ${({theme}) => theme.sizes.minibar.height};
    padding: 0 ${({theme}) => theme.space[1.5]} 0 ${({theme}) => theme.space[0.5]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.pill};
    background: ${({theme}) => theme.colors.raised};
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
    background: ${({theme}) => theme.colors.surface};
    color: ${({theme}) => theme.colors.text};
    ${({theme}) => theme.text.label};
    ${press};

    &:hover {
        background: ${({theme}) => theme.colors.border};
    }
`

const StopLabel = styled(m.span)`
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

const statusSwap = {
    initial: {opacity: 0, y: 4},
    animate: {opacity: 1, y: 0},
    exit: {opacity: 0, y: -4},
    transition: tween('fast'),
}

const reveal = {
    initial: {opacity: 0, x: -4},
    animate: {opacity: 1, x: 0},
    exit: {opacity: 0, transition: tween('fast', 'exit')},
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
function useOpenOnHover() {
    const [hovered, setHovered] = useState(false)
    const [focused, setFocused] = useState(false)
    return {
        open: hovered || focused,
        handlers: {
            onPointerEnter: () => setHovered(true),
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
}: MinibarPillProps) {
    const theme = useTheme()
    const hover = useOpenOnHover()
    const finishing = phase === 'finishing'
    const paused = phase === 'paused'
    const open = !finishing && (held || hover.open)
    const ringSize = px(theme.sizes.minibar.ring)
    const pauseLabel = paused ? 'Resume recording' : 'Pause recording'
    const status = failure ?? (finishing ? 'Finishing…' : paused ? 'Paused' : 'Recording')

    return (
        <Pill
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
                        <Swap key={status} {...statusSwap}>{status}</Swap>
                    </AnimatePresence>
                </Status>
            </Clock>
            {finishing ? (
                <Waiting><Spinner size={ICON_DEFAULTS.size}/></Waiting>
            ) : (
                <Stop type="button" aria-label="Stop and save" aria-keyshortcuts={stopKeys} onClick={onStop}>
                    <StopIcon size={theme.sizes.meter.icon} weight="fill" aria-hidden/>
                    <AnimatePresence initial={false}>
                        {open && <StopLabel key="label" {...reveal}>Stop</StopLabel>}
                    </AnimatePresence>
                </Stop>
            )}
            <AnimatePresence initial={false}>
                {open && (
                    <More key="more" {...reveal}>
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
                    </More>
                )}
            </AnimatePresence>
        </Pill>
    )
}
