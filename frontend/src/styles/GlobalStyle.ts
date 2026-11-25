import {createGlobalStyle} from 'styled-components'
import {THEME_SWITCH_TRANSITION_NAME} from './themeTransition'

export const GlobalStyle = createGlobalStyle`
    *,
    *::before,
    *::after {
        box-sizing: border-box;
    }

    html,
    body,
    #root {
        margin: 0;
        padding: 0;
        height: 100%;
    }

    html {
        color-scheme: ${({theme}) => theme.name};
        background: ${({theme}) => theme.colors.bg};
    }

    /* Thin scrollbars in the border colour, in every scroll area (both inherit). */
    :root {
        scrollbar-width: thin;
        scrollbar-color: ${({theme}) => theme.colors.border} transparent;
    }

    body {
        font-family: ${({theme}) => theme.fonts.sans};
        ${({theme}) => theme.text.body};
        color: ${({theme}) => theme.colors.text};
        background: ${({theme}) => theme.colors.bg};
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
    }

    button,
    input,
    select,
    textarea {
        font: inherit;
        color: inherit;
    }

    h1, h2, h3, h4, p {
        margin: 0;
    }

    /* A theme change (changeThemeSmoothly): the old window crossfades into the new. */
    ::view-transition-old(root),
    ::view-transition-new(root) {
        animation-duration: ${({theme}) => theme.motion.duration.base};
        animation-timing-function: ${({theme}) => theme.motion.easing.standard};
    }

    /* The theme switch shows live: its thumb slides once, not in two frames. */
    ::view-transition-old(${THEME_SWITCH_TRANSITION_NAME}) {
        display: none;
    }

    ::view-transition-group(${THEME_SWITCH_TRANSITION_NAME}),
    ::view-transition-new(${THEME_SWITCH_TRANSITION_NAME}) {
        animation: none;
    }
`
