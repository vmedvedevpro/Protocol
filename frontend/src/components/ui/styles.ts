import {css} from 'styled-components'

/**
 * Keyboard focus: a solid outline in the text colour, drawn at once (never
 * transitioned) and only for keyboard focus.
 */
export const focusRing = css`
    &:focus-visible {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: 1px;
    }
`

/** Colour feedback on hover and press, over `fast`. */
export const colorTransition = css`
    transition-property: color, background-color, border-color;
    transition-duration: ${({theme}) => theme.motion.duration.fast};
    transition-timing-function: ${({theme}) => theme.motion.easing.standard};
`

/** The floating surface of a menu and a select's list. */
export const popoverSurface = css`
    min-width: ${({theme}) => theme.sizes.popover.minWidth};
    padding: ${({theme}) => theme.space[1]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.raised};
    box-shadow: ${({theme}) => theme.shadows.popover};
    color: ${({theme}) => theme.colors.text};
    outline: none;
`

/**
 * One row of a menu or a select's list. The highlight under the pointer or
 * the arrow keys is one shape that slides between rows (SlidingHighlight), so
 * a row paints above it rather than filling itself. Radix marks an
 * unavailable row with `data-disabled`.
 */
export const popoverItem = css`
    position: relative;
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    height: ${({theme}) => theme.sizes.control.sm};
    padding: 0 ${({theme}) => theme.space[2]};
    border-radius: ${({theme}) => theme.radii.xs};
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.text};
    cursor: pointer;
    outline: none;
    user-select: none;
    ${colorTransition};

    &[data-disabled] {
        color: ${({theme}) => theme.colors.muted};
        cursor: default;
    }

    svg {
        flex: none;
    }
`

/** A theme length (`'8px'`) as the number Radix takes for an offset. */
export const px = (length: string) => Number.parseFloat(length)
