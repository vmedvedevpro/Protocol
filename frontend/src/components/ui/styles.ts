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

/**
 * A focused text field: a 2 px stroke in the text colour, so focus differs
 * from hover's `muted` border by more than a shade. One outline drawn over
 * the field's 1 px border and the first pixel of its padding (outlines follow
 * `border-radius` in Chromium and WebKit): a border plus a 1 px spread
 * shadow snap to device pixels separately, and at a fractional scale such
 * as 175 % one side came out thinner. The field still turns its border to
 * the text colour, so no rounding shows a seam. Drawn at once, like
 * focusRing.
 */
export const fieldFocusRing = css`
    outline: 2px solid ${({theme}) => theme.colors.text};
    outline-offset: -2px;
`

/**
 * The keyboard's row in a menu or a list: an inset ring in `muted`. The
 * highlight's fill (`surface` on `raised`) barely shows, and the pointer has
 * the row under it to go by; the keyboard gets this as well. Rows show it on
 * `:focus-visible`, so the pointer's look stays the design's.
 */
export const keyboardRowRing = css`
    outline: 1px solid ${({theme}) => theme.colors.muted};
    outline-offset: -1px;
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

    &:focus-visible {
        ${keyboardRowRing};
    }

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
