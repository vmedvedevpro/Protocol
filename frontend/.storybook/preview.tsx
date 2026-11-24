import '../src/styles/fonts'
import type {Decorator, Preview} from '@storybook/react-vite'
import {IconContext} from '@phosphor-icons/react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {ThemeProvider} from 'styled-components'
import {installMockIpc} from '../src/mocks/ipc'
import {resetMockState} from '../src/mocks/state'
import {GlobalStyle} from '../src/styles/GlobalStyle'
import {ICON_DEFAULTS} from '../src/styles/icons'
import {type ThemeName, themes} from '../src/styles/theme'

// Stories that use queries talk to the same mock IPC as `pnpm dev`.
installMockIpc()

const queryClient = new QueryClient({defaultOptions: {queries: {retry: false}}})

// The theme comes from the toolbar or a story's `globals`, not from the
// app's theme mode store.
const withAppProviders: Decorator = (Story, context) => {
    const theme = themes[context.globals.theme as ThemeName] ?? themes.light
    return (
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <GlobalStyle/>
                <IconContext.Provider value={ICON_DEFAULTS}>
                    <Story/>
                </IconContext.Provider>
            </ThemeProvider>
        </QueryClientProvider>
    )
}

const preview: Preview = {
    decorators: [withAppProviders],
    globalTypes: {
        theme: {
            description: 'Theme',
            toolbar: {
                title: 'Theme',
                icon: 'mirror',
                items: [
                    {value: 'light', title: 'Light'},
                    {value: 'dark', title: 'Dark'},
                ],
                dynamicTitle: true,
            },
        },
    },
    initialGlobals: {
        theme: 'light',
    },
    parameters: {
        layout: 'centered',
    },
    beforeEach: () => {
        resetMockState()
        queryClient.clear()
    },
}

export default preview
