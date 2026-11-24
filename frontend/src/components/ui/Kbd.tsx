import type {ComponentProps} from 'react'
import styled, {css} from 'styled-components'

/**
 * Where the hint sits: `surface` on the window or a raised card (the
 * default), `raised` on a field that is itself `surface` (the search box),
 * `fill` on a filled button (Record).
 */
export type KbdTone = 'surface' | 'raised' | 'fill'

const TONES = {
    surface: css`
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.muted};
    `,
    raised: css`
        background: ${({theme}) => theme.colors.raised};
        color: ${({theme}) => theme.colors.muted};
    `,
    fill: css`
        background: ${({theme}) => theme.colors.fillHint};
        color: inherit;
    `,
}

const Key = styled.kbd<{ $tone: KbdTone }>`
    display: inline-flex;
    flex: none;
    align-items: center;
    padding: 1px ${({theme}) => theme.space[1.5]};
    border-radius: ${({theme}) => theme.radii.xs};
    font-family: inherit;
    ${({theme}) => theme.text.caption};
    white-space: nowrap;
    ${({$tone}) => TONES[$tone]};
`

type KbdProps = ComponentProps<'kbd'> & {
    tone?: KbdTone
}

/** A keyboard shortcut hint; write the keys with `formatShortcut('K')`. */
export function Kbd({tone = 'surface', ...props}: KbdProps) {
    return <Key $tone={tone} {...props}/>
}
