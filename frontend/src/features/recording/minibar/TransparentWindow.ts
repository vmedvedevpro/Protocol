import {createGlobalStyle} from 'styled-components'

// minibar.rs makes the minibar's window transparent so the pill's corners
// read as round. `:root` outranks GlobalStyle's `html` and `body` whatever
// order the two global styles are injected in.
export const TransparentWindow = createGlobalStyle`
    :root,
    :root body {
        background: transparent;
    }
`
