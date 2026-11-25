import {type KeyboardEvent, useEffect, useRef} from 'react'
import {PauseIcon, PlayIcon, SpeakerSlashIcon} from '@phosphor-icons/react'
import styled from 'styled-components'
import {formatClock} from '@/components/transcript/turns'
import {Spinner} from '@/components/ui/Spinner'
import {colorTransition, focusRing} from '@/components/ui/styles'
import {Tooltip} from '@/components/ui/Tooltip'
import {useHotkey} from '@/lib/hotkeys'
import {MOTION_OK, SCALE_FROM} from '@/styles/motion'
import {type MeetingPlayer, type PlayerStatus, SKIP_SECONDS} from './player'

const Bar = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2.5]};
    height: ${({theme}) => theme.sizes.bar.footer};
    padding: 0 ${({theme}) => theme.space[3]} 0 ${({theme}) => theme.space[2.5]};
`

const PlayButton = styled.button`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.control.md};
    height: ${({theme}) => theme.sizes.control.md};
    padding: 0;
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.raised};
    color: ${({theme}) => theme.colors.text};
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    &:hover:not(:disabled) {
        background: ${({theme}) => theme.colors.surface};
    }

    &:disabled {
        color: ${({theme}) => theme.colors.muted};
        cursor: default;
    }

    ${MOTION_OK} {
        transition-property: background-color, color, scale;

        &:active:not(:disabled) {
            scale: ${SCALE_FROM};
        }
    }
`

const Clock = styled.span<{ $muted?: boolean }>`
    flex: none;
    font-family: ${({theme}) => theme.fonts.mono};
    ${({theme}) => theme.text.small};
    font-variant-numeric: tabular-nums;
    color: ${({theme, $muted}) => ($muted ? theme.colors.muted : theme.colors.text)};
`

// The track fills up to --progress, a CSS variable the clock writes on every
// frame (never a styled prop: each value would make a new class).
const Scrubber = styled.input`
    flex: 1;
    min-width: 0;
    height: ${({theme}) => theme.space[5]};
    margin: 0;
    background: transparent;
    cursor: pointer;
    appearance: none;
    outline: none;

    &::-webkit-slider-runnable-track {
        height: ${({theme}) => theme.sizes.progress};
        border-radius: ${({theme}) => theme.radii.pill};
        background: linear-gradient(
            to right,
            ${({theme}) => theme.colors.text} var(--progress, 0%),
            ${({theme}) => theme.colors.border} var(--progress, 0%)
        );
    }

    &::-webkit-slider-thumb {
        width: ${({theme}) => theme.space[2.5]};
        height: ${({theme}) => theme.space[2.5]};
        margin-top: calc((${({theme}) => theme.sizes.progress} - ${({theme}) => theme.space[2.5]}) / 2);
        border: 0;
        border-radius: 50%;
        background: ${({theme}) => theme.colors.text};
        appearance: none;
    }

    &:focus-visible::-webkit-slider-thumb {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: 2px;
    }

    &:disabled {
        cursor: default;
    }
`

const Speed = styled.button`
    flex: none;
    min-width: ${({theme}) => theme.space[9]};
    height: ${({theme}) => theme.sizes.chip};
    padding: 0 ${({theme}) => theme.space[1.5]};
    border: 0;
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme}) => theme.colors.surface};
    color: ${({theme}) => theme.colors.text};
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.medium};
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    &:hover:not(:disabled) {
        background: ${({theme}) => theme.colors.border};
    }

    &:disabled {
        color: ${({theme}) => theme.colors.muted};
        cursor: default;
    }
`

const Unavailable = styled.p`
    display: flex;
    flex: 1;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    margin: 0;
    padding-left: ${({theme}) => theme.space[1.5]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const rateLabel = (rate: number) => `${rate}×`

interface PlayerBarProps {
    player: MeetingPlayer
    status: PlayerStatus
    playing: boolean
    duration: number
    rate: number
}

/**
 * The meeting's player, docked as the screen's bar: play and pause (Space
 * anywhere on the meeting, unless a control has focus), the position, the
 * scrubber (← and → skip 5 s while it has focus), the length and the
 * speed. The position and the scrubber follow the player's clock through
 * refs, so playback renders nothing.
 */
export function PlayerBar({player, status, playing, duration, rate}: PlayerBarProps) {
    const position = useRef<HTMLSpanElement>(null)
    const scrubber = useRef<HTMLInputElement>(null)
    const ready = status === 'ready'

    useHotkey({code: 'Space'}, () => player.toggle(), {enabled: ready})

    useEffect(() => player.clock.subscribe((seconds) => {
        const input = scrubber.current
        if (position.current) position.current.textContent = formatClock(seconds)
        if (!input) return
        input.value = String(seconds)
        input.setAttribute('aria-valuetext', `${formatClock(seconds)} of ${formatClock(duration)}`)
        input.style.setProperty('--progress', duration > 0 ? `${Math.min(100, (seconds / duration) * 100)}%` : '0%')
    }), [player, duration])

    if (status === 'unavailable' || status === 'error') {
        return (
            <Bar role="group" aria-label="Playback">
                <Unavailable>
                    <SpeakerSlashIcon aria-hidden/>
                    {status === 'error' ? 'The recording couldn’t be played.' : 'No audio was saved for this meeting.'}
                </Unavailable>
            </Bar>
        )
    }

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        player.skip(event.key === 'ArrowLeft' ? -SKIP_SECONDS : SKIP_SECONDS)
    }

    return (
        <Bar role="group" aria-label="Playback">
            <Tooltip content={playing ? 'Pause' : 'Play'} shortcut="Space">
                <PlayButton
                    type="button"
                    disabled={!ready}
                    aria-label={playing ? 'Pause' : 'Play'}
                    aria-busy={status === 'loading' || undefined}
                    onClick={player.toggle}
                >
                    {/* Loading usually ends at once: the spinner shows only if it does not. */}
                    {status === 'loading'
                        ? <Spinner delayed/>
                        : playing ? <PauseIcon weight="fill" aria-hidden/> : <PlayIcon weight="fill" aria-hidden/>}
                </PlayButton>
            </Tooltip>
            <Clock ref={position}>{formatClock(player.position)}</Clock>
            <Scrubber
                ref={scrubber}
                type="range"
                aria-label="Playback position"
                min={0}
                max={duration || 0}
                step="any"
                defaultValue={0}
                disabled={!ready}
                onChange={(event) => player.seek(Number(event.target.value))}
                onKeyDown={onKeyDown}
            />
            <Clock $muted>{formatClock(duration)}</Clock>
            <Tooltip content="Playback speed">
                <Speed type="button" disabled={!ready} aria-label={`Playback speed ${rateLabel(rate)}`} onClick={player.nextRate}>
                    {rateLabel(rate)}
                </Speed>
            </Tooltip>
        </Bar>
    )
}
