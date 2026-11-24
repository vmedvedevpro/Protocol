import type {ReactNode} from 'react'
import {IconContext} from '@phosphor-icons/react'
import {Toaster} from '@/components/ui/Toast'
import {TooltipProvider} from '@/components/ui/Tooltip'
import {ICON_DEFAULTS} from '@/styles/icons'
import {MotionProvider} from './MotionProvider'

/**
 * What every UI primitive expects above it, besides the theme: motion's
 * features and settings, the icon defaults, the shared tooltip delay and
 * the window's one Toaster. App, Storybook's decorator and the tests'
 * `renderUi` mount the same set, each with its own theme.
 */
export function UiProviders({children}: { children: ReactNode }) {
    return (
        <MotionProvider>
            <IconContext.Provider value={ICON_DEFAULTS}>
                <TooltipProvider>
                    {children}
                    <Toaster/>
                </TooltipProvider>
            </IconContext.Provider>
        </MotionProvider>
    )
}
