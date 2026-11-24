import type {ReactNode} from 'react'
import {ThemeProvider} from 'styled-components'
import {type AppTheme, lightTheme} from '@/styles/theme'

/** Wraps a component under test in a theme, light unless the test says. */
export function inTheme(node: ReactNode, theme: AppTheme = lightTheme) {
    return <ThemeProvider theme={theme}>{node}</ThemeProvider>
}
