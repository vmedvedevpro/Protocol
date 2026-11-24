import {RecordIcon} from '@phosphor-icons/react'
import styled, {createGlobalStyle} from 'styled-components'

// minibar.rs makes this window transparent so the pill's corners read as
// round. `:root` outranks GlobalStyle's `html` and `body` whatever order the
// two global styles are injected in.
const TransparentWindow = createGlobalStyle`
    :root,
    :root body {
        background: transparent;
    }
`

const Bar = styled.div`
    display: grid;
    place-items: center;
    height: 100%;
`

const Pill = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    height: ${({theme}) => theme.sizes.control.lg};
    padding: 0 ${({theme}) => theme.space[4]} 0 ${({theme}) => theme.space[3]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.pill};
    background: ${({theme}) => theme.colors.raised};
    color: ${({theme}) => theme.colors.muted};
    ${({theme}) => theme.text.small};
`

/** A stand-in for the recording bar that minibar.rs shows while the window is minimized. */
export function MinibarPlaceholder() {
    return (
        <Bar>
            <TransparentWindow/>
            <Pill>
                <RecordIcon aria-hidden/>
                Minibar placeholder
            </Pill>
        </Bar>
    )
}
