import {createElement, type ReactElement} from 'react'
import {IconContext} from '@phosphor-icons/react'
import {render} from '@testing-library/react'
import {ThemeProvider} from 'styled-components'
import {MotionProvider} from '@/app/MotionProvider'
import {ICON_DEFAULTS} from '@/styles/icons'
import {lightTheme} from '@/styles/theme'
import {TooltipProvider} from './Tooltip'

const withProviders = (ui: ReactElement) =>
    createElement(ThemeProvider, {theme: lightTheme},
        createElement(MotionProvider, null,
            createElement(IconContext.Provider, {value: ICON_DEFAULTS},
                createElement(TooltipProvider, null, ui))))

/**
 * Renders a primitive under the providers the app and Storybook give it;
 * `rerender` keeps them. For tests only.
 */
export function renderUi(ui: ReactElement) {
    const result = render(withProviders(ui))
    return {...result, rerender: (next: ReactElement) => result.rerender(withProviders(next))}
}
