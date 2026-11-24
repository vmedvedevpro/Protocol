import {type ComponentProps, type ReactNode, useContext, useId} from 'react'
import styled, {css} from 'styled-components'
import {ControlLabelContext} from './controlLabelling'
import {colorTransition} from './styles'

/** sm: 28 px inside a settings row; md: 32 px, most fields; lg: 36 px, a field that stands alone. */
export type FieldSize = 'sm' | 'md' | 'lg'

/** outline: a bordered field on the window or a card; soft: a borderless grey field, such as a search box. */
export type FieldTone = 'outline' | 'soft'

// The border darkens on hover and turns to the text colour on focus, over
// `fast`; a field shows focus by its border rather than an outline, since it
// already has one. A field with an icon draws this box around the icon and a
// bare input, so it follows the focus inside it.
const fieldBox = (focus: '&:focus' | '&:focus-within') => css<{ $tone: FieldTone }>`
    width: 100%;
    min-width: 0;
    margin: 0;
    border: 1px solid ${({theme, $tone}) => $tone === 'soft' ? 'transparent' : theme.colors.border};
    background: ${({theme, $tone}) => $tone === 'soft' ? theme.colors.surface : theme.colors.raised};
    color: ${({theme}) => theme.colors.text};
    ${colorTransition};

    &:hover {
        border-color: ${({theme}) => theme.colors.muted};
    }

    ${focus} {
        border-color: ${({theme}) => theme.colors.text};
        outline: none;
    }
`

const placeholder = css`
    &::placeholder {
        color: ${({theme}) => theme.colors.muted};
        opacity: 1;
    }

    &:disabled {
        color: ${({theme}) => theme.colors.muted};
    }
`

const SIZES = {
    sm: css`
        height: ${({theme}) => theme.sizes.control.sm};
        padding: 0 ${({theme}) => theme.space[2]};
        border-radius: ${({theme}) => theme.radii.sm};
        ${({theme}) => theme.text.label};
        font-weight: ${({theme}) => theme.fontWeights.regular};
    `,
    md: css`
        height: ${({theme}) => theme.sizes.control.md};
        padding: 0 ${({theme}) => theme.space[2.5]};
        border-radius: ${({theme}) => theme.radii.md};
        ${({theme}) => theme.text.body};
    `,
    lg: css`
        height: ${({theme}) => theme.sizes.control.lg};
        padding: 0 ${({theme}) => theme.space[3]};
        border-radius: ${({theme}) => theme.radii.md};
        ${({theme}) => theme.text.input};
    `,
}

const Input = styled.input<{ $size: FieldSize, $tone: FieldTone }>`
    ${fieldBox('&:focus')};
    ${({$size}) => SIZES[$size]};
    ${placeholder};
`

const Frame = styled.div<{ $size: FieldSize, $tone: FieldTone }>`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    ${fieldBox('&:focus-within')};
    ${({$size}) => SIZES[$size]};
    padding-right: ${({theme}) => theme.space[1.5]};

    > svg {
        flex: none;
        color: ${({theme}) => theme.colors.muted};
    }
`

const BareInput = styled.input`
    flex: 1;
    align-self: stretch;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    outline: none;
    ${placeholder};

    /* The search clear button would crowd the field; Escape clears it. */
    &::-webkit-search-cancel-button,
    &::-webkit-search-decoration {
        appearance: none;
    }
`

const Area = styled.textarea<{ $tone: FieldTone, $mono: boolean }>`
    ${fieldBox('&:focus')};
    display: block;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
    border-radius: ${({theme}) => theme.radii.md};
    ${({theme}) => theme.text.body};
    resize: vertical;
    ${placeholder};

    ${({$mono}) => $mono && css`
        font-family: ${({theme}) => theme.fonts.mono};
        ${({theme}) => theme.text.small};
    `};
`

const Stack = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2]};
    min-width: 0;
`

const Label = styled.label`
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

const Hint = styled.p`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

interface FieldText {
    /** A visible label above the field. Without it, pass `aria-label` or put the field in a SettingsRow. */
    label?: string
    /** A line under the field, read as its description. */
    hint?: string
    tone?: FieldTone
}

/** The ARIA names a caller can give a field instead of `label`. */
interface AriaNaming {
    'aria-label'?: string
    'aria-labelledby'?: string
}

/**
 * The label above, the hint below, and the ids that tie them to the field.
 * Without a name of its own (`label`, `aria-label`, `aria-labelledby`), a
 * field in a SettingsRow takes the row's: `aria-labelledby` would win over the
 * field's `aria-label`.
 */
function useFieldText(label: string | undefined, hint: string | undefined, id: string | undefined, aria: AriaNaming) {
    const autoId = useId()
    const row = useContext(ControlLabelContext)
    const fieldId = id ?? autoId
    const hintId = hint ? `${fieldId}-hint` : undefined
    const named = label !== undefined || aria['aria-label'] !== undefined || aria['aria-labelledby'] !== undefined
    const fromRow = named ? null : row

    const naming = {
        'aria-labelledby': fromRow?.labelId,
        'aria-describedby': [hintId, fromRow?.descriptionId].filter(Boolean).join(' ') || undefined,
    }

    const wrap = (field: ReactNode) => label || hint ? (
        <Stack>
            {label && <Label htmlFor={fieldId}>{label}</Label>}
            {field}
            {hint && <Hint id={hintId}>{hint}</Hint>}
        </Stack>
    ) : field

    return {fieldId, naming, wrap}
}

type TextFieldProps = Omit<ComponentProps<'input'>, 'size'> & FieldText & {
    size?: FieldSize
    /** An icon at the start, such as a magnifier on a search field. */
    icon?: ReactNode
    /** Something at the end, such as `<Kbd>` with the field's shortcut. */
    trailing?: ReactNode
}

/** A single-line text input. */
export function TextField({
    label,
    hint,
    tone = 'outline',
    size = 'md',
    icon,
    trailing,
    id,
    type = 'text',
    ...props
}: TextFieldProps) {
    const {fieldId, naming, wrap} = useFieldText(label, hint, id, props)

    if (icon === undefined && trailing === undefined) {
        return wrap(<Input id={fieldId} type={type} $size={size} $tone={tone} {...naming} {...props}/>)
    }
    return wrap(
        <Frame $size={size} $tone={tone}>
            {icon}
            <BareInput id={fieldId} type={type} {...naming} {...props}/>
            {trailing}
        </Frame>,
    )
}

type TextAreaProps = ComponentProps<'textarea'> & FieldText & {
    /** Monospace, for lists such as words to recognize. */
    mono?: boolean
}

/** A multi-line text input that the user can make taller. */
export function TextArea({label, hint, tone = 'outline', mono = false, id, rows = 3, ...props}: TextAreaProps) {
    const {fieldId, naming, wrap} = useFieldText(label, hint, id, props)
    return wrap(<Area id={fieldId} rows={rows} $tone={tone} $mono={mono} {...naming} {...props}/>)
}
