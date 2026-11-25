import {MicrophoneIcon, MicrophoneSlashIcon, SpeakerHighIcon, SpeakerSlashIcon, WarningIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {css, useTheme} from 'styled-components'
import type {AudioSource, LevelFeed} from '@/api/audio'
import {colorTransition, focusRing} from '@/components/ui/styles'
import {Tooltip} from '@/components/ui/Tooltip'
import {Veil} from '@/components/ui/Veil'
import {VisuallyHidden} from '@/components/ui/VisuallyHidden'
import {MOTION_OK, SCALE_FROM, statusSwap} from '@/styles/motion'
import type {LevelWarning} from './levelAdvice'
import {LevelMeter} from './LevelMeter'

const NAMES: Record<AudioSource, string> = {mic: 'microphone', system: 'computer audio'}

const ICONS = {
    mic: {on: MicrophoneIcon, muted: MicrophoneSlashIcon},
    system: {on: SpeakerHighIcon, muted: SpeakerSlashIcon},
} as const

const WARNINGS: Record<LevelWarning, { name: string, advice: string }> = {
    loud: {
        name: 'too loud',
        advice: 'Too loud: computer audio is being limited. Lower the call or playback volume, or System volume in Settings › Recording.',
    },
    quiet: {
        name: 'low audio',
        advice: 'Low audio: computer audio is very quiet. If someone is speaking, raise the call or playback volume, or System volume in Settings › Recording.',
    },
}

// Muted inverts the button (the text colour as its fill), so it stands out
// without a hue, as the design's notes ask: the ring is the only colour.
const Button = styled.button<{ $muted: boolean, $warning: boolean }>`
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

    /* The fill is the colour behind the content's veil as it swaps. */
    background: var(--surface);

    ${({$muted}) => ($muted
        ? css`
            --surface: ${({theme}) => theme.colors.text};
            color: ${({theme}) => theme.colors.bg};

            &:hover {
                --surface: ${({theme}) => theme.colors.soft};
            }
        `
        : css`
            --surface: ${({theme}) => theme.colors.surface};
            color: ${({theme}) => theme.colors.text};

            &:hover {
                --surface: ${({theme}) => theme.colors.border};
            }
        `)}

    /* A warning outlines the button in the text colour: it stands out without a hue. */
    ${({$warning, $muted}) => $warning && !$muted && css`
        box-shadow: inset 0 0 0 1px ${({theme}) => theme.colors.text};
    `}

    ${focusRing};

    ${MOTION_OK} {
        transition-property: color, background-color, border-color, transform;

        &:active {
            transform: scale(${SCALE_FROM});
        }
    }
`

const Content = styled(m.span)`
    position: relative;
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
    /**
     * Advice on the level (`useSystemAudioWarning`, computer audio only): a
     * warning icon takes the source's place, the bars stay, and the tooltip
     * says what to do.
     */
    warning?: LevelWarning | null
    /**
     * Off in the minibar, whose window is the pill's height and would clip
     * a tooltip; the button keeps its name and its warning.
     */
    tooltip?: boolean
}

/**
 * The microphone or computer-audio button of the recording bar and the
 * minibar: the source's icon and its level, or, when muted, a slashed icon and
 * "Muted" on an inverted fill. A level warning puts a warning icon in the
 * source's place and outlines the button. Each swap animates as a status
 * change.
 */
export function SourceMeter({source, muted, level, onToggle, warning = null, tooltip = true}: SourceMeterProps) {
    const theme = useTheme()
    const name = NAMES[source]
    const shown = muted ? null : warning
    const Icon = shown ? WarningIcon : ICONS[source][muted ? 'muted' : 'on']
    const state = muted ? 'muted' : shown ?? 'on'

    // The name comes from the content, so it holds the visible "Muted"
    // (WCAG 2.5.3): "Mute microphone" while on, "Muted microphone" while
    // muted, with aria-pressed for the state. The tooltip says what a click does.
    return (
        <Tooltip disabled={!tooltip} content={muted ? `Turn on ${name}` : shown ? WARNINGS[shown].advice : `Mute ${name}`}>
            <Button type="button" aria-pressed={muted} $muted={muted} $warning={!!shown} onClick={onToggle}>
                <AnimatePresence mode="wait" initial={false}>
                    {/* "Muted" never fades: the content swaps under a veil (Veil). */}
                    <Content key={state} {...statusSwap}>
                        <Icon size={theme.sizes.meter.icon} aria-hidden="true"/>
                        {muted ? (
                            <>
                                <span>Muted</span>
                                <VisuallyHidden>{` ${name}`}</VisuallyHidden>
                            </>
                        ) : (
                            <>
                                <LevelMeter level={level}/>
                                <VisuallyHidden>{shown ? `Mute ${name}, ${WARNINGS[shown].name}` : `Mute ${name}`}</VisuallyHidden>
                            </>
                        )}
                        <Veil duration="fast"/>
                    </Content>
                </AnimatePresence>
            </Button>
        </Tooltip>
    )
}
