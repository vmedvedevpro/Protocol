import type {ReactNode} from 'react'
import {IconContext} from '@phosphor-icons/react'
import {TooltipProvider} from '@/components/ui/Tooltip'
import {ICON_DEFAULTS} from '@/styles/icons'
import {MotionProvider} from './MotionProvider'

/**
 * What every UI primitive expects above it, besides the theme: motion's
 * features and settings, the icon defaults and the shared tooltip delay.
 * App, Storybook's decorator and the tests' `renderUi` mount the same set,
 * each with its own theme.
 */
export function UiProviders({children}: { children: ReactNode }) {
    return (
        <MotionProvider>
            <IconContext.Provider value={ICON_DEFAULTS}>
                <TooltipProvider>{children}</TooltipProvider>
            </IconContext.Provider>
        </MotionProvider>
    )
}
