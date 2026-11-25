import * as RadixToast from '@radix-ui/react-toast'
import {CheckCircleIcon, InfoIcon, WarningCircleIcon, WarningIcon, XIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import {type ReactNode, useEffect, useState} from 'react'
import styled, {useTheme} from 'styled-components'
import {springs, statusSwap, tween} from '@/styles/motion'
import {Button, IconButton} from './Button'
import {Spinner} from './Spinner'
import {focusRing} from './styles'
import {TOAST_DURATION_MS, type ToastData, type ToastTone, toast, useToastStore} from './toastStore'
import {Veil} from './Veil'
import {VisuallyHidden} from './VisuallyHidden'

// The design draws no toast; this one takes the look of the Home banner
// (an icon, a medium title, a muted line, small buttons on the raised
// surface) and floats it where the old app's toasts were, under the title
// strip, like a sheet. Radix gives the behaviour: the timer that pauses
// under the pointer, on focus and while the window is in the background,
// Escape, F8 to reach the toasts, and the announcement to screen readers.

// The column hangs under the window's header, as a sheet does. Toasts stay
// usable over an open sheet: they come before its portal in the document,
// so they need the stacking order, and Radix's modal lock on <body>
// (pointer-events: none) must not reach them.
const Viewport = styled(RadixToast.Viewport)`
    position: fixed;
    top: calc(${({theme}) => theme.sizes.bar.header} + ${({theme}) => theme.space[2]});
    right: 0;
    left: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2]};
    width: calc(100% - 2 * ${({theme}) => theme.space[3]});
    max-width: calc(${({theme}) => theme.sizes.window.width} - 2 * ${({theme}) => theme.space[3]});
    margin: 0 auto;
    padding: 0;
    list-style: none;
    outline: none;
    pointer-events: auto;
`

const Item = styled(m.li)`
    display: flex;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[2.5]};
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.lg};
    background: ${({theme}) => theme.colors.raised};
    box-shadow: ${({theme}) => theme.shadows.popover};
    color: ${({theme}) => theme.colors.text};
    /* The colour of the veil its content swaps under. */
    --surface: ${({theme}) => theme.colors.raised};
    ${focusRing};
`

const Content = styled(m.div)`
    position: relative;
    display: flex;
    flex: 1;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[2.5]};
    min-width: 0;
`

// The icon sits on the title's line.
const Icon = styled.span`
    display: flex;
    flex: none;
    align-items: center;
    height: ${({theme}) => theme.text.body.lineHeight};
    color: ${({theme}) => theme.colors.muted};
`

const Text = styled.div`
    flex: 1;
    min-width: 0;
`

const Title = styled(RadixToast.Title)`
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

// Integrity errors carry two 64-character hashes.
const Description = styled(RadixToast.Description)`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
    overflow-wrap: anywhere;
`

const Actions = styled.div`
    display: flex;
    gap: ${({theme}) => theme.space[1.5]};
    margin-top: ${({theme}) => theme.space[2]};
`

// A 28 px button centred on the 20 px title line.
const Close = styled.div`
    flex: none;
    margin: calc(-1 * ${({theme}) => theme.space[1]}) 0;
`

const ICONS: Record<ToastTone, ReactNode> = {
    message: null,
    success: <CheckCircleIcon aria-hidden/>,
    info: <InfoIcon aria-hidden/>,
    warning: <WarningIcon aria-hidden/>,
    error: <WarningCircleIcon aria-hidden/>,
    loading: <Spinner/>,
}

function ToastItem({data}: { data: ToastData }) {
    const theme = useTheme()
    const offset = `-${theme.space[2]}`
    const icon = ICONS[data.tone]

    return (
        <RadixToast.Root
            asChild
            forceMount
            open
            onOpenChange={(open) => {
                if (!open) toast.dismiss(data.id)
            }}
            duration={data.duration}
            // A failure or a warning interrupts; the rest waits its turn.
            type={data.tone === 'error' || data.tone === 'warning' ? 'foreground' : 'background'}
            // A mouse drag on a desktop toast is not a dismissal.
            onSwipeEnd={(event) => event.preventDefault()}
        >
            <Item
                initial={{opacity: 0, y: offset}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: offset, transition: tween('base', 'exit')}}
                transition={springs.gentle}
            >
                <AnimatePresence mode="wait" initial={false}>
                    {/* A change of meaning in place (loading, then the outcome) swaps
                        the content as a status line does: a rise under a veil. */}
                    <Content key={`${data.tone}:${data.title}`} {...statusSwap}>
                        {icon && <Icon>{icon}</Icon>}
                        <Text>
                            <Title>{data.title}</Title>
                            {data.description && <Description>{data.description}</Description>}
                            {data.action && (
                                <Actions>
                                    <RadixToast.Action asChild altText={data.action.altText ?? data.action.label}>
                                        <Button size="sm" onClick={data.action.onClick}>{data.action.label}</Button>
                                    </RadixToast.Action>
                                </Actions>
                            )}
                        </Text>
                        <Veil duration="fast"/>
                    </Content>
                </AnimatePresence>
                <Close>
                    <RadixToast.Close asChild>
                        <IconButton label="Close" tooltip={false}>
                            <XIcon size={12} aria-hidden/>
                        </IconButton>
                    </RadixToast.Close>
                </Close>
            </Item>
        </RadixToast.Root>
    )
}

// How long an announcement stays in the document: long enough for a screen
// reader to read it, as Radix's own (ToastAnnounce) does.
const ANNOUNCE_MS = 1000

/**
 * Announces what a replaced toast now says. Like Radix's announcement it is
 * in the document only briefly: it mounts empty, so the live region exists
 * before its text arrives on the next frame, then removes itself.
 */
function Announcement({text}: { text: string }) {
    const [said, setSaid] = useState('')

    useEffect(() => {
        const frame = requestAnimationFrame(() => setSaid(text))
        const done = window.setTimeout(() => useToastStore.setState({replaced: null}), ANNOUNCE_MS)
        return () => {
            cancelAnimationFrame(frame)
            window.clearTimeout(done)
        }
    }, [text])

    return <VisuallyHidden role="status">{said}</VisuallyHidden>
}

/**
 * The window's toasts, newest on top, under the title strip. Mounted once,
 * by UiProviders; `toast` (./toastStore) shows one from anywhere. A toast
 * arrives from above on `springs.gentle` and leaves upwards with
 * `tween('base', 'exit')`, as a sheet does.
 */
export function Toaster() {
    const toasts = useToastStore((state) => state.toasts)
    const replaced = useToastStore((state) => state.replaced)

    return (
        <RadixToast.Provider label="Notification" duration={TOAST_DURATION_MS} swipeDirection="up">
            <AnimatePresence>
                {toasts.map((data) => <ToastItem key={data.id} data={data}/>)}
            </AnimatePresence>
            <Viewport/>
            {replaced && <Announcement key={replaced.seq} text={replaced.text}/>}
        </RadixToast.Provider>
    )
}
