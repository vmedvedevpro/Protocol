import * as m from 'motion/react-m'
import styled from 'styled-components'
import {colorTransition, focusRing} from '@/components/ui/styles'
import {tween} from '@/styles/motion'

/**
 * A line that needs attention: a failure, or what a choice costs. The window
 * is greyscale, so weight and the text colour mark it.
 */
export const Warning = styled.p`
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.medium};
    color: ${({theme}) => theme.colors.text};
`

/** A slider across a row, its value after it: the volumes, Nemotron's threshold. */
export const SliderLine = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
`

export const Range = styled.input`
    flex: 1;
    min-width: 0;
    height: ${({theme}) => theme.sizes.control.sm};
    margin: 0;
    background: transparent;
    accent-color: ${({theme}) => theme.colors.text};
    cursor: pointer;
    ${focusRing};
`

export const SliderValue = styled.span`
    flex: none;
    min-width: 4ch;
    ${({theme}) => theme.text.small};
    font-variant-numeric: tabular-nums;
    color: ${({theme}) => theme.colors.muted};
    text-align: right;
`

/** What a row's control shows beside its buttons: "Installed", "In use". */
export const RowValue = styled.span<{$strong?: boolean}>`
    ${({theme}) => theme.text.small};
    font-weight: ${({theme, $strong}) => ($strong ? theme.fontWeights.medium : theme.fontWeights.regular)};
    color: ${({theme, $strong}) => ($strong ? theme.colors.text : theme.colors.muted)};
    white-space: nowrap;
`

/** A row's buttons and value on its right. */
export const RowControls = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`


/**
 * A quiet action that is text only, beside a row's main button: Back. No
 * padding of its own, so its words sit where text sits.
 */
export const QuietButton = styled.button`
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: none;
    ${({theme}) => theme.text.label};
    color: ${({theme}) => theme.colors.muted};
    white-space: nowrap;
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    &:hover:not(:disabled) {
        color: ${({theme}) => theme.colors.text};
    }

    &:disabled {
        cursor: default;
        opacity: 0.5;
    }
`

/** A text button that opens what follows it in a Collapse, its caret turning: What's new, Credits. */
export const Disclosure = styled.button`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    align-self: flex-start;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: none;
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.medium};
    color: ${({theme}) => theme.colors.soft};
    cursor: pointer;
    ${focusRing};

    &:hover {
        color: ${({theme}) => theme.colors.text};
    }

    > svg {
        transition: transform ${({theme}) => theme.motion.duration.base} ${({theme}) => theme.motion.easing.standard};
    }

    &[aria-expanded='true'] > svg {
        transform: rotate(180deg);
    }
`

// Chips: chosen apps, summary languages.

export const Chips = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

/** `$selected`: a pinned language, outlined in the text colour. */
export const Chip = styled(m.span)<{$selected?: boolean}>`
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    height: ${({theme}) => theme.sizes.control.sm};
    padding: 0 ${({theme}) => theme.space[1]} 0 ${({theme}) => theme.space[2.5]};
    border: 1px solid ${({theme, $selected}) => $selected ? theme.colors.text : theme.colors.border};
    border-radius: ${({theme}) => theme.radii.pill};
    background: ${({theme}) => theme.colors.raised};
    ${colorTransition};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.text};
`

/** A small round button inside a chip: remove, pin. */
export const ChipButton = styled.button`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.pill};
    background: transparent;
    color: ${({theme}) => theme.colors.muted};
    cursor: pointer;
    ${focusRing};

    &:hover {
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.text};
    }
`

/** Chips grow in and shrink out; a chip's Veil does the fade, so its text never fades. */
export const chipMotion = {
    initial: {scale: 0.9},
    animate: {scale: 1},
    exit: {scale: 0.9},
    transition: tween('fast'),
}
