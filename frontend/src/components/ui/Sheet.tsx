import {type ReactNode, useRef} from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import {XIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {useTheme} from 'styled-components'
import {platform} from '@/lib/platform'
import {springs, tween} from '@/styles/motion'
import {IconButton} from './Button'
import {VisuallyHidden} from './VisuallyHidden'

// Behaviour and motion follow micka_design's Dialog on 21st.dev
// (https://21st.dev/@micka_design/components/dialog): Radix's dialog with the
// scrim and the panel force-mounted, so motion plays them in and out, and a
// spring for the panel. Here the panel hangs under the window's header, as on
// the design's sheets, and the spring and fades are the theme's.

// The scrim starts under the window's title strip (TitleBar), which stays
// live: on Windows and Linux it holds the window's own buttons and drags the
// window, and the modal sheet must not take those away.
const Scrim = styled(m.div)`
    position: fixed;
    inset: ${({theme}) => theme.sizes.titleBar[platform]} 0 0;
    background: ${({theme}) => theme.colors.scrim};
`

// Hangs under the window's header, inset from its sides, and never taller
// than the window leaves room for; the body scrolls inside.
const Panel = styled(m.div)`
    position: fixed;
    top: calc(${({theme}) => theme.sizes.bar.header} + ${({theme}) => theme.space[2]});
    right: 0;
    left: 0;
    display: flex;
    flex-direction: column;
    width: calc(100% - 2 * ${({theme}) => theme.space[3]});
    max-width: calc(${({theme}) => theme.sizes.window.width} - 2 * ${({theme}) => theme.space[3]});
    max-height: calc(100% - ${({theme}) => theme.sizes.bar.header} - ${({theme}) => theme.space[2]} - ${({theme}) => theme.space[6]});
    margin: 0 auto;
    overflow: hidden;
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.raised};
    box-shadow: ${({theme}) => theme.shadows.dialog};
    color: ${({theme}) => theme.colors.text};
    outline: none;
`

const Header = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[3]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[0.5]} ${({theme}) => theme.space[4]};
`

const Title = styled(Dialog.Title)`
    flex: 1;
    min-width: 0;
    ${({theme}) => theme.text.heading};
`

const Description = styled(Dialog.Description)`
    flex: none;
    padding: 0 ${({theme}) => theme.space[4]};
    ${({theme}) => theme.text.label};
    font-weight: ${({theme}) => theme.fontWeights.regular};
    color: ${({theme}) => theme.colors.muted};
`

const Body = styled.div`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: ${({theme}) => theme.space[3]} ${({theme}) => theme.space[4]} ${({theme}) => theme.space[3.5]};
`

const Footer = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: flex-end;
    gap: ${({theme}) => theme.space[1.5]};
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[4]};
    border-top: 1px solid ${({theme}) => theme.colors.border};
`

interface SheetProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    /** A line under the title, read as the sheet's description. */
    description?: string
    /** The actions at the bottom: Cancel inside `<SheetClose asChild>`, then the main action. */
    footer?: ReactNode
    /**
     * The children fill the panel, as search does with its own field and
     * list: no visible header or close button (the title still names the
     * dialog for screen readers), no padding, and the children scroll
     * themselves. Escape and a press outside still close it.
     */
    bare?: boolean
    /**
     * Appears and goes at once, scrim and all: for what a shortcut toggles
     * many times a day (⌘K's search), where any motion is a wait.
     */
    instant?: boolean
    children: ReactNode
}

/**
 * Where focus goes back when the sheet closes: the control that had it when
 * the sheet opened. A menu item leaves with its menu, so an item resolves to
 * the button that opened its menu, through every submenu; Radix names a
 * menu by that button (`aria-labelledby`).
 */
function openerOf(focused: Element | null): HTMLElement | null {
    let opener = focused
    for (let menu = opener?.closest('[role="menu"]'); menu; menu = opener?.closest('[role="menu"]')) {
        opener = document.getElementById(menu.getAttribute('aria-labelledby') ?? '')
    }
    return opener instanceof HTMLElement ? opener : null
}

/**
 * A dialog over the dimmed window, opened by its owner through `open`. Focus
 * moves into it and stays there until it closes; Escape, the close button and
 * a click on the scrim close it, and focus goes back to the control that
 * opened it (`openerOf`). The window's title strip stays uncovered and
 * working above the scrim. It arrives from above on
 * `springs.gentle` while the scrim fades in over `base`, and leaves with
 * `tween('base', 'exit')`; an `instant` one appears and goes at once.
 */
export function Sheet({open, onOpenChange, title, description, footer, bare = false, instant = false, children}: SheetProps) {
    const theme = useTheme()
    // Radix returns focus only to its own Trigger; the sheet remembers the
    // opener itself, so a button, a menu item or a shortcut all work alike.
    const returnFocus = useRef<HTMLElement | null>(null)
    const offset = `-${theme.space[4]}`

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <AnimatePresence>
                {open && (
                    <Dialog.Portal forceMount>
                        <Dialog.Overlay forceMount asChild>
                            {/* Without an exit, AnimatePresence removes an instant sheet at once. */}
                            <Scrim
                                initial={instant ? false : {opacity: 0}}
                                animate={{opacity: 1}}
                                exit={instant ? undefined : {opacity: 0, transition: tween('base', 'exit')}}
                                transition={tween('base')}
                            />
                        </Dialog.Overlay>
                        <Dialog.Content
                            forceMount
                            asChild
                            // Without a description, no dangling aria-describedby.
                            {...(description ? {} : {'aria-describedby': undefined})}
                            onOpenAutoFocus={() => {
                                returnFocus.current = openerOf(document.activeElement)
                            }}
                            onCloseAutoFocus={(event) => {
                                event.preventDefault()
                                if (returnFocus.current?.isConnected) returnFocus.current.focus()
                            }}
                            // A press on the title strip is the window's (minimize,
                            // close, drag), not a click outside that closes the sheet.
                            onPointerDownOutside={(event) => {
                                if (event.target instanceof Element && event.target.closest('header')) event.preventDefault()
                            }}
                        >
                            <Panel
                                initial={instant ? false : {opacity: 0, y: offset}}
                                animate={{opacity: 1, y: 0}}
                                exit={instant ? undefined : {opacity: 0, y: offset, transition: tween('base', 'exit')}}
                                transition={springs.gentle}
                            >
                                {bare ? (
                                    <VisuallyHidden><Dialog.Title>{title}</Dialog.Title></VisuallyHidden>
                                ) : (
                                    <Header>
                                        <Title>{title}</Title>
                                        <Dialog.Close asChild>
                                            <IconButton label="Close" tooltip={false}>
                                                <XIcon size={12} aria-hidden/>
                                            </IconButton>
                                        </Dialog.Close>
                                    </Header>
                                )}
                                {description && <Description>{description}</Description>}
                                {bare ? children : <Body>{children}</Body>}
                                {footer && <Footer>{footer}</Footer>}
                            </Panel>
                        </Dialog.Content>
                    </Dialog.Portal>
                )}
            </AnimatePresence>
        </Dialog.Root>
    )
}

/** Closes the sheet it is in: wrap Cancel with `<SheetClose asChild>`. */
export const SheetClose = Dialog.Close
