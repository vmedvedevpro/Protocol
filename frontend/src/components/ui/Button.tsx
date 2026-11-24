import type {ComponentProps, ReactNode} from 'react'
import styled, {css} from 'styled-components'
import {MOTION_OK, SCALE_FROM} from '@/styles/motion'
import {colorTransition, focusRing} from './styles'
import {Tooltip} from './Tooltip'

export type ButtonVariant = 'filled' | 'secondary' | 'ghost'

/** sm: 28 px, inside rows and banners; md: 30 px, a sheet's footer, Record. */
export type ButtonSize = 'sm' | 'md'

// Hover and press move one step along the greyscale; disabled drops to
// `muted` text instead of fading, so it stays legible.
const VARIANTS = {
    filled: css`
        border-color: ${({theme}) => theme.colors.text};
        background: ${({theme}) => theme.colors.text};
        color: ${({theme}) => theme.colors.bg};

        &:hover:not(:disabled) {
            border-color: ${({theme}) => theme.colors.soft};
            background: ${({theme}) => theme.colors.soft};
        }

        &:disabled {
            border-color: ${({theme}) => theme.colors.border};
            background: ${({theme}) => theme.colors.border};
            color: ${({theme}) => theme.colors.muted};
        }
    `,
    secondary: css`
        border-color: ${({theme}) => theme.colors.border};
        background: ${({theme}) => theme.colors.raised};
        color: ${({theme}) => theme.colors.text};

        &:hover:not(:disabled) {
            background: ${({theme}) => theme.colors.surface};
        }

        &:disabled {
            color: ${({theme}) => theme.colors.muted};
        }
    `,
    ghost: css`
        border-color: transparent;
        background: transparent;
        color: ${({theme}) => theme.colors.text};

        &:hover:not(:disabled) {
            background: ${({theme}) => theme.colors.surface};
        }

        &:disabled {
            color: ${({theme}) => theme.colors.muted};
        }
    `,
}

// Shared by Button and IconButton: the press scale lives inside MOTION_OK, so
// reduced motion keeps only the colour change.
const pressable = css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    margin: 0;
    border: 1px solid transparent;
    cursor: pointer;
    user-select: none;
    ${colorTransition};
    ${focusRing};

    &:disabled {
        cursor: default;
    }

    ${MOTION_OK} {
        transition-property: color, background-color, border-color, transform;

        &:active:not(:disabled) {
            transform: scale(${SCALE_FROM});
        }
    }
`

const StyledButton = styled.button<{ $variant: ButtonVariant, $size: ButtonSize, $trailing: boolean }>`
    ${pressable};
    gap: ${({theme}) => theme.space[2]};
    ${({$variant}) => VARIANTS[$variant]};
    white-space: nowrap;

    ${({$size}) => $size === 'sm' ? css`
        height: ${({theme}) => theme.sizes.control.sm};
        padding: 0 ${({theme}) => theme.space[2.5]};
        border-radius: ${({theme}) => theme.radii.sm};
        ${({theme}) => theme.text.label};
    ` : css`
        height: ${({theme}) => theme.sizes.control.base};
        padding: 0 ${({theme}) => theme.space[3]};
        border-radius: ${({theme}) => theme.radii.md};
        ${({theme}) => theme.text.body};
        font-weight: ${({theme}) => theme.fontWeights.medium};
    `};

    /* A trailing shortcut sits close to the edge, as on Record. */
    ${({$trailing}) => $trailing && css`
        padding-right: ${({theme}) => theme.space[1.5]};
    `};
`

type ButtonProps = ComponentProps<'button'> & {
    /** filled: the one main action; secondary: an outlined action; ghost: Cancel and quiet actions. */
    variant?: ButtonVariant
    size?: ButtonSize
    /** An icon before the label. */
    icon?: ReactNode
    /** After the label, usually a `<Kbd tone="fill">` shortcut. */
    trailing?: ReactNode
}

export function Button({
    variant = 'secondary',
    size = 'md',
    icon,
    trailing,
    type = 'button',
    children,
    ...props
}: ButtonProps) {
    return (
        <StyledButton type={type} $variant={variant} $size={size} $trailing={trailing !== undefined} {...props}>
            {icon}
            {children}
            {trailing}
        </StyledButton>
    )
}

/** sm: 28 px, in a header or a row; md: 32 px, the Linux title bar. */
export type IconButtonSize = 'sm' | 'md'

const StyledIconButton = styled.button<{ $size: IconButtonSize }>`
    ${pressable};
    width: ${({theme, $size}) => theme.sizes.control[$size]};
    height: ${({theme, $size}) => theme.sizes.control[$size]};
    padding: 0;
    border-radius: ${({theme, $size}) => $size === 'sm' ? theme.radii.sm : theme.radii.md};
    background: transparent;
    color: ${({theme}) => theme.colors.muted};

    &:hover:not(:disabled),
    &[aria-pressed='true'],
    &[aria-expanded='true'] {
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.text};
    }
`

type IconButtonProps = Omit<ComponentProps<'button'>, 'aria-label' | 'children'> & {
    /** The accessible name, also shown as the tooltip. Required: the button has no text. */
    label: string
    /** Shown in the tooltip, from `formatShortcut`. */
    shortcut?: string
    /** A toggle such as Keep on top: sets `aria-pressed` and keeps the fill while on. */
    pressed?: boolean
    size?: IconButtonSize
    /** Off for a button whose tooltip would only repeat what is next to it. */
    tooltip?: boolean
    /** The icon, a Phosphor `*Icon`. */
    children: ReactNode
}

/**
 * A square button with only an icon. Its `label` names it for assistive
 * technology and shows as a tooltip on hover and keyboard focus.
 */
export function IconButton({
    label,
    shortcut,
    pressed,
    size = 'sm',
    tooltip = true,
    type = 'button',
    children,
    ...props
}: IconButtonProps) {
    const button = (
        <StyledIconButton type={type} aria-label={label} aria-pressed={pressed} $size={size} {...props}>
            {children}
        </StyledIconButton>
    )
    return tooltip ? <Tooltip content={label} shortcut={shortcut}>{button}</Tooltip> : button
}
