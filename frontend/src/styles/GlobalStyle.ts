import {createGlobalStyle} from 'styled-components'

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
`
