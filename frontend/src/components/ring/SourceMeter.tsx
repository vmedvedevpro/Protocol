import {MicrophoneIcon, MicrophoneSlashIcon, SpeakerHighIcon, SpeakerSlashIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {css, useTheme} from 'styled-components'
import type {AudioSource, LevelFeed} from '@/api/audio'
import {colorTransition, focusRing} from '@/components/ui/styles'
import {Tooltip} from '@/components/ui/Tooltip'
import {VisuallyHidden} from '@/components/ui/VisuallyHidden'
import {MOTION_OK, SCALE_FROM, tween} from '@/styles/motion'
import {LevelMeter} from './LevelMeter'

const NAMES: Record<AudioSource, string> = {mic: 'microphone', system: 'computer audio'}

const ICONS = {
    mic: {on: MicrophoneIcon, muted: MicrophoneSlashIcon},
    system: {on: SpeakerHighIcon, muted: SpeakerSlashIcon},
} as const

// Muted inverts the button (the text colour as its fill), so it stands out
// without a hue, as the design's notes ask: the ring is the only colour.
const Button = styled.button<{ $muted: boolean }>`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    min-width: ${({theme}) => theme.sizes.meter.button};
    height: ${({theme}) => theme.sizes.control.md};
    padding: 0 ${({theme}) => theme.space[2.5]};
    border: 0;
    border-radius: ${({theme}) => theme.radii.pill};
    font: inherit;
    ${({theme}) => theme.text.caption};
    font-weight: ${({theme}) => theme.fontWeights.medium};
    cursor: pointer;
    ${colorTransition};

    ${({$muted}) => ($muted
        ? css`
            background: ${({theme}) => theme.colors.text};
            color: ${({theme}) => theme.colors.bg};

            &:hover {
                background: ${({theme}) => theme.colors.soft};
            }
        `
        : css`
            background: ${({theme}) => theme.colors.surface};
            color: ${({theme}) => theme.colors.text};

            &:hover {
                background: ${({theme}) => theme.colors.border};
            }
        `)}

    ${focusRing};

    ${MOTION_OK} {
        transition-property: color, background-color, border-color, transform;

        &:active {
            transform: scale(${SCALE_FROM});
        }
    }
`

const Content = styled(m.span)`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

interface SourceMeterProps {
    source: AudioSource
    muted: boolean
    /** Where the bars read the level; null keeps them at rest (paused). */
    level: LevelFeed | null
    /** Mute or turn the source back on; the caller owns the native call. */
    onToggle: () => void
}

/**
 * The microphone or computer-audio button of the recording bar and the
 * minibar: the source's icon and its level, or, when muted, a slashed icon and
 * "Muted" on an inverted fill. The swap animates as a status change.
 */
export function SourceMeter({source, muted, level, onToggle}: SourceMeterProps) {
    const theme = useTheme()
    const name = NAMES[source]
    const Icon = ICONS[source][muted ? 'muted' : 'on']

    // The name comes from the content, so it holds the visible "Muted"
    // (WCAG 2.5.3): "Mute microphone" while on, "Muted microphone" while
    // muted, with aria-pressed for the state. The tooltip says what a click does.
    return (
        <Tooltip content={muted ? `Turn on ${name}` : `Mute ${name}`}>
            <Button type="button" aria-pressed={muted} $muted={muted} onClick={onToggle}>
                <AnimatePresence mode="wait" initial={false}>
                    <Content
                        key={muted ? 'muted' : 'on'}
                        initial={{opacity: 0, y: 4}}
                        animate={{opacity: 1, y: 0}}
                        exit={{opacity: 0, y: -4}}
                        transition={tween('fast')}
                    >
                        <Icon size={theme.sizes.meter.icon} aria-hidden="true"/>
                        {muted ? (
                            <>
                                <span>Muted</span>
                                <VisuallyHidden>{` ${name}`}</VisuallyHidden>
                            </>
                        ) : (
                            <>
                                <LevelMeter level={level}/>
                                <VisuallyHidden>{`Mute ${name}`}</VisuallyHidden>
                            </>
                        )}
                    </Content>
                </AnimatePresence>
            </Button>
        </Tooltip>
    )
}
