import {createContext, type ReactElement, type ReactNode, useContext, useState} from 'react'
import * as RadixTooltip from '@radix-ui/react-tooltip'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {useTheme} from 'styled-components'
import {SCALE_FROM, tween} from '@/styles/motion'
import {Kbd} from './Kbd'
import {px} from './styles'

// How long the pointer rests on a control before its tooltip opens, and the
// window after one closes in which the next opens at once, so moving along a
// row of icon buttons does not wait again on each.
const OPEN_DELAY_MS = 500
const SKIP_DELAY_MS = 300

const SharedProvider = createContext(false)

/**
 * Shares the open delay between every tooltip under it. Mount it once near
 * the root; a tooltip outside one still works, with a provider of its own.
 */
export function TooltipProvider({children}: { children: ReactNode }) {
    return (
        <RadixTooltip.Provider delayDuration={OPEN_DELAY_MS} skipDelayDuration={SKIP_DELAY_MS}>
            <SharedProvider.Provider value={true}>{children}</SharedProvider.Provider>
        </RadixTooltip.Provider>
    )
}

// Inverted, like the filled button, so it reads as a hint above the window.
const Tip = styled(m.div)`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
    padding: ${({theme}) => theme.space[1]} ${({theme}) => theme.space[2]};
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme}) => theme.colors.text};
    box-shadow: ${({theme}) => theme.shadows.popover};
    color: ${({theme}) => theme.colors.bg};
    ${({theme}) => theme.text.small};
    transform-origin: var(--radix-tooltip-content-transform-origin);
`

interface TooltipProps {
    content: string
    /** A shortcut that does the same, from `formatShortcut`. */
    shortcut?: string
    side?: 'top' | 'right' | 'bottom' | 'left'
    /** The control; it must accept a ref and spread its props onto a DOM element. */
    children: ReactElement
}

/**
 * A hint on hover and keyboard focus. It opens and closes as menus do: a fade
 * and a scale from `SCALE_FROM` toward its control, over `fast`.
 */
export function Tooltip({content, shortcut, side = 'bottom', children}: TooltipProps) {
    const shared = useContext(SharedProvider)
    const theme = useTheme()
    // Controlled, so AnimatePresence sees it close and plays the exit.
    const [open, setOpen] = useState(false)

    const tooltip = (
        <RadixTooltip.Root open={open} onOpenChange={setOpen}>
            <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
            <AnimatePresence>
                {open && (
                    <RadixTooltip.Portal forceMount>
                        {/* The label names the hidden copy Radix reads out, instead of a second Tip. */}
                        <RadixTooltip.Content
                            forceMount
                            asChild
                            side={side}
                            sideOffset={px(theme.space[1.5])}
                            collisionPadding={px(theme.space[2])}
                            aria-label={shortcut ? `${content} (${shortcut})` : content}
                        >
                            <Tip
                                initial={{opacity: 0, scale: SCALE_FROM}}
                                animate={{opacity: 1, scale: 1}}
                                exit={{opacity: 0, scale: SCALE_FROM}}
                                transition={tween('fast')}
                            >
                                {content}
                                {shortcut && <Kbd tone="fill">{shortcut}</Kbd>}
                            </Tip>
                        </RadixTooltip.Content>
                    </RadixTooltip.Portal>
                )}
            </AnimatePresence>
        </RadixTooltip.Root>
    )

    return shared ? tooltip : <TooltipProvider>{tooltip}</TooltipProvider>
}
