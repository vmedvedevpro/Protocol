import {createElement, type ReactElement} from 'react'
import {render} from '@testing-library/react'
import {ThemeProvider} from 'styled-components'
import {UiProviders} from '@/app/UiProviders'
import {lightTheme} from '@/styles/theme'

const withProviders = (ui: ReactElement) =>
    createElement(ThemeProvider, {theme: lightTheme}, createElement(UiProviders, null, ui))

/** Renders UI under the providers the app and Storybook give it; `rerender` keeps them. */
export function renderUi(ui: ReactElement) {
    const result = render(withProviders(ui))
    return {...result, rerender: (next: ReactElement) => result.rerender(withProviders(next))}
}
