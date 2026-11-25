import {type ComponentProps, type ReactElement, type ReactNode, type Ref, useCallback, useId, useState} from 'react'
import * as RadixMenu from '@radix-ui/react-dropdown-menu'
import {CaretRightIcon, CheckIcon, CircleIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {useTheme} from 'styled-components'
import {SCALE_FROM, tween} from '@/styles/motion'
import {useSlidingHighlight} from './SlidingHighlight'
import {popoverItem, popoverSurface, px} from './styles'

// Behaviour and accessibility come from Radix's dropdown menu: focus moves
// into the menu, arrow keys and typing a name move between items, Enter and
// Space choose, Escape closes and returns focus to the button. The look, the
// structure and the kinds of items follow shadcn's dropdown menu on 21st.dev
// (https://21st.dev/@shadcn/components/dropdown-menu), rebuilt on the theme.
// The kinds built are those the app's menus use: actions, checkable items,
// groups and submenus (the old app moved a meeting to a group through one),
// without shadcn's destructive red in a greyscale window. The hover that
// slides between items comes from 0xUrvish's Smooth Dropdown
// (SlidingHighlight), and the labelled groups from originui's labeled
// grouped items
// (https://21st.dev/@originui/components/dropdown-menu/labeled-grouped-items).

// Radix sets the transform origin on the side of the button the menu opened
// from; the menu grows from there. The surface draws the border and the
// shadow once and never scrolls: as its own scroll container (overflow on
// both axes) the shadow was painted with the scrolled layer and showed cut
// or doubled at the edges. Rows scroll inside it, as a select's list does.
const Surface = styled(m.div)`
    ${popoverSurface};
    display: flex;
    flex-direction: column;
    max-width: var(--radix-dropdown-menu-content-available-width);
    max-height: var(--radix-dropdown-menu-content-available-height);
    padding: 0;
    transform-origin: var(--radix-dropdown-menu-content-transform-origin);
`

// The items' offset parent, for the highlight, and what scrolls.
const Rows = styled.div`
    position: relative;
    flex: 1;
    min-height: 0;
    padding: ${({theme}) => theme.space[1]};
    overflow-y: auto;
`

// An item's icon is muted beside its text, as in shadcn's menu.
const Item = styled(RadixMenu.Item)`
    ${popoverItem};

    > svg {
        color: ${({theme}) => theme.colors.muted};
    }
`

// A submenu's item stays filled while its submenu is open, as in shadcn's
// menu, since the sliding highlight leaves with the pointer.
const SubTrigger = styled(RadixMenu.SubTrigger)`
    ${popoverItem};

    > svg {
        color: ${({theme}) => theme.colors.muted};
    }

    &[data-state='open'] {
        border-radius: ${({theme}) => theme.radii.xs};
        background: ${({theme}) => theme.colors.surface};
    }
`

const CheckboxItem = styled(RadixMenu.CheckboxItem)`
    ${popoverItem};
`

const RadioItem = styled(RadixMenu.RadioItem)`
    ${popoverItem};
`

// Checkable items keep a column for the mark (a check, or a dot for one
// choice of several), where other items show an icon, so their text lines up
// whether or not they are checked.
const Mark = styled.span`
    display: flex;
    flex: none;
    width: ${({theme}) => theme.space[4]};
    justify-content: center;
`

const Text = styled.span`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`

const Shortcut = styled.span`
    flex: none;
    margin-left: ${({theme}) => theme.space[4]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

// Above the highlight, which never slides across it (DIVIDER_SELECTOR).
const GroupLabel = styled(RadixMenu.Label)`
    position: relative;
    padding: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[2]};
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

const Line = styled(RadixMenu.Separator)`
    height: 1px;
    margin: ${({theme}) => theme.space[1]} -${({theme}) => theme.space[1]};
    background: ${({theme}) => theme.colors.border};
`

const pop = {
    initial: {opacity: 0, scale: SCALE_FROM},
    animate: {opacity: 1, scale: 1},
    exit: {opacity: 0, scale: SCALE_FROM},
    transition: tween('fast'),
}

/**
 * The animated surface of a menu or a submenu, with its own sliding
 * highlight. Radix's content renders it through `asChild`, so it passes on
 * every prop Radix gives it, joining Radix's ref and focus handler with the
 * highlight's.
 */
type SurfaceProps = Omit<ComponentProps<typeof Surface>, 'children'> & { children: ReactNode }

function MenuSurface({children, ref, onFocus, ...props}: SurfaceProps) {
    const {handlers, highlight} = useSlidingHighlight('[role^="menuitem"]')
    const track = handlers.ref
    const joinedRef = useCallback((node: HTMLDivElement | null) => {
        assignRef(ref, node)
        track(node)
    }, [ref, track])

    return (
        <Surface
            {...pop}
            {...props}
            ref={joinedRef}
            onFocus={(event) => {
                onFocus?.(event)
                handlers.onFocus(event)
            }}
        >
            <Rows>
                {highlight}
                {children}
            </Rows>
        </Surface>
    )
}

function assignRef<T>(ref: Ref<T> | undefined, node: T) {
    if (typeof ref === 'function') ref(node)
    else if (ref) ref.current = node
}

interface MenuProps {
    /** The button that opens the menu; it must accept a ref and spread its props (Button and IconButton do). */
    trigger: ReactElement
    /** Which edge of the button the menu lines up with. */
    align?: 'start' | 'center' | 'end'
    side?: 'top' | 'bottom'
    children: ReactNode
}

/**
 * A list of actions or choices under a button. It opens and closes with a
 * fade and a scale from `SCALE_FROM` toward the button over `fast`, and one
 * highlight slides between its items on `springs.snappy`.
 */
export function Menu({trigger, align = 'end', side = 'bottom', children}: MenuProps) {
    const theme = useTheme()
    // Controlled, so AnimatePresence sees it close and plays the exit.
    const [open, setOpen] = useState(false)

    return (
        <RadixMenu.Root open={open} onOpenChange={setOpen}>
            <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
            <AnimatePresence>
                {open && (
                    <RadixMenu.Portal forceMount>
                        <RadixMenu.Content
                            forceMount
                            asChild
                            align={align}
                            side={side}
                            sideOffset={px(theme.space[1])}
                            collisionPadding={px(theme.space[2])}
                        >
                            <MenuSurface>{children}</MenuSurface>
                        </RadixMenu.Content>
                    </RadixMenu.Portal>
                )}
            </AnimatePresence>
        </RadixMenu.Root>
    )
}

interface MenuItemProps {
    onSelect: () => void
    /** A Phosphor `*Icon` before the text. */
    icon?: ReactNode
    /** The shortcut that does the same, from `formatShortcut`. */
    shortcut?: string
    disabled?: boolean
    children: ReactNode
}

/** An action; choosing it closes the menu. */
export function MenuItem({onSelect, icon, shortcut, disabled, children}: MenuItemProps) {
    return (
        <Item onSelect={onSelect} disabled={disabled}>
            {icon}
            <Text>{children}</Text>
            {shortcut && <Shortcut>{shortcut}</Shortcut>}
        </Item>
    )
}

interface MenuCheckboxItemProps {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
    disabled?: boolean
    children: ReactNode
}

/** Something on or off, such as recording the computer's sound. */
export function MenuCheckboxItem({checked, onCheckedChange, disabled, children}: MenuCheckboxItemProps) {
    return (
        <CheckboxItem checked={checked} onCheckedChange={onCheckedChange} disabled={disabled}>
            <Mark>
                <RadixMenu.ItemIndicator><CheckIcon aria-hidden/></RadixMenu.ItemIndicator>
            </Mark>
            <Text>{children}</Text>
        </CheckboxItem>
    )
}

interface MenuRadioGroupProps<T extends string> {
    value: T
    onValueChange: (value: T) => void
    children: ReactNode
}

/** One choice out of the MenuRadioItems inside, such as the microphone. */
export function MenuRadioGroup<T extends string>({value, onValueChange, children}: MenuRadioGroupProps<T>) {
    return (
        <RadixMenu.RadioGroup value={value} onValueChange={(next) => onValueChange(next as T)}>
            {children}
        </RadixMenu.RadioGroup>
    )
}

interface MenuRadioItemProps {
    value: string
    disabled?: boolean
    children: ReactNode
}

export function MenuRadioItem({value, disabled, children}: MenuRadioItemProps) {
    return (
        <RadioItem value={value} disabled={disabled}>
            <Mark>
                <RadixMenu.ItemIndicator><CircleIcon size={8} weight="fill" aria-hidden/></RadixMenu.ItemIndicator>
            </Mark>
            <Text>{children}</Text>
        </RadioItem>
    )
}

interface MenuGroupProps {
    /** A small heading over the group, which also names it. */
    label?: string
    children: ReactNode
}

/** Items that belong together; put a MenuSeparator between groups. */
export function MenuGroup({label, children}: MenuGroupProps) {
    const labelId = useId()
    return (
        <RadixMenu.Group aria-labelledby={label ? labelId : undefined}>
            {label && <GroupLabel id={labelId} data-highlight-divider="">{label}</GroupLabel>}
            {children}
        </RadixMenu.Group>
    )
}

interface MenuSubProps {
    label: string
    /** A Phosphor `*Icon` before the label. */
    icon?: ReactNode
    disabled?: boolean
    /** The submenu's items. */
    children: ReactNode
}

/**
 * An item that opens a further menu beside it, on hover, Enter or the right
 * arrow; the left arrow and Escape go back. It opens and closes as a menu.
 */
export function MenuSub({label, icon, disabled, children}: MenuSubProps) {
    const theme = useTheme()
    // Controlled, so AnimatePresence sees it close and plays the exit.
    const [open, setOpen] = useState(false)

    return (
        <RadixMenu.Sub open={open} onOpenChange={setOpen}>
            <SubTrigger disabled={disabled}>
                {icon}
                <Text>{label}</Text>
                <CaretRightIcon size={11} aria-hidden/>
            </SubTrigger>
            <AnimatePresence>
                {open && (
                    <RadixMenu.Portal forceMount>
                        <RadixMenu.SubContent
                            forceMount
                            asChild
                            sideOffset={px(theme.space[1])}
                            collisionPadding={px(theme.space[2])}
                        >
                            <MenuSurface>{children}</MenuSurface>
                        </RadixMenu.SubContent>
                    </RadixMenu.Portal>
                )}
            </AnimatePresence>
        </RadixMenu.Sub>
    )
}

export function MenuSeparator() {
    return <Line/>
}
