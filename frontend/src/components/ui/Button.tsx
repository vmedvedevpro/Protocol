import type {ComponentProps, ReactNode} from 'react'
import styled, {css, type DefaultTheme, keyframes} from 'styled-components'
import {ICON_DEFAULTS} from '@/styles/icons'
import {MOTION_OK, SCALE_FROM} from '@/styles/motion'
import {Spinner} from './Spinner'
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
    position: relative;
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

const hide = keyframes`
    to {
        opacity: 0;
    }
`

// Ends at the spinner's own opacity.
const show = keyframes`
    from {
        opacity: 0;
    }
`

// The step both take: none until spinner.delay, then all at once.
const atDelay = ({theme}: { theme: DefaultTheme }) => `0s ${theme.motion.spinner.delay}`

// The label and what goes with it, laid out as the button lays out its
// children. While pending it turns transparent when the spinner arrives
// after spinner.delay, in one step and never by fading (text ending an
// opacity animation blinks), so an action that ends at once never swaps the label out. It
// keeps the button's width and stays in the accessibility tree, so the
// button keeps its name.
const Content = styled.span<{ $pending: boolean }>`
    display: inline-flex;
    align-items: center;
    gap: inherit;

    ${({$pending}) => $pending && css`
        animation: ${hide} ${atDelay} forwards;
    `};
`

// The spinner shows in the same step as the label goes, on the same delay:
// a spinner fading in after it would leave the button empty for a moment.
const Pending = styled.span`
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: ${show} ${atDelay} both;
`

/** Children are the label, after an icon if it has one. */
type ButtonProps = ComponentProps<'button'> & {
    /** filled: the one main action; secondary: an outlined action; ghost: Cancel and quiet actions. */
    variant?: ButtonVariant
    size?: ButtonSize
    /** After the label, usually a `<Kbd tone="fill">` shortcut. */
    trailing?: ReactNode
    /**
     * What the click started is still running: the button is disabled and
     * `aria-busy` at once, and if it runs past `theme.motion.spinner.delay` a
     * spinner stands in for the label at the button's width until it ends.
     */
    pending?: boolean
}

export function Button({
    variant = 'secondary',
    size = 'md',
    trailing,
    pending = false,
    disabled,
    type = 'button',
    children,
    ...props
}: ButtonProps) {
    return (
        <StyledButton
            type={type}
            disabled={disabled || pending}
            aria-busy={pending || undefined}
            $variant={variant}
            $size={size}
            $trailing={trailing !== undefined}
            {...props}
        >
            <Content $pending={pending}>
                {children}
                {trailing}
            </Content>
            {pending && <Pending><Spinner size={ICON_DEFAULTS.size}/></Pending>}
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
