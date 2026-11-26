import {useEffect, useState} from 'react'
import * as RadixSelect from '@radix-ui/react-select'
import {CaretDownIcon, CheckIcon} from '@phosphor-icons/react'
import * as m from 'motion/react-m'
import styled, {useTheme} from 'styled-components'
import {durations, SCALE_FROM, tween} from '@/styles/motion'
import {useControlLabelling} from './controlLabelling'
import {useSlidingHighlight} from './SlidingHighlight'
import {Spinner} from './Spinner'
import {colorTransition, focusRing, popoverItem, popoverSurface, px} from './styles'

export interface SelectOption<T extends string> {
    value: T
    label: string
}

// The button in a settings row: the current choice, cut with an ellipsis
// when long, and a caret.
const Trigger = styled(RadixSelect.Trigger)`
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
    max-width: ${({theme}) => theme.sizes.popover.triggerMaxWidth};
    height: ${({theme}) => theme.sizes.control.sm};
    margin: 0;
    padding: 0 ${({theme}) => theme.space[2]} 0 ${({theme}) => theme.space[2.5]};
    border: 1px solid ${({theme}) => theme.colors.controlBorder};
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme}) => theme.colors.raised};
    color: ${({theme}) => theme.colors.text};
    ${({theme}) => theme.text.label};
    font-weight: ${({theme}) => theme.fontWeights.regular};
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    &:hover:not(:disabled),
    &[data-state='open'] {
        background: ${({theme}) => theme.colors.surface};
    }

    &:disabled {
        color: ${({theme}) => theme.colors.muted};
        cursor: default;
    }

    &[data-placeholder] {
        color: ${({theme}) => theme.colors.muted};
    }

    > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    > svg {
        flex: none;
        color: ${({theme}) => theme.colors.muted};
    }
`

// Radix's Icon clones its child, which Spinner would not take; the span wears
// the caret's place and colour.
const PendingMark = styled.span`
    display: inline-flex;
    flex: none;
    color: ${({theme}) => theme.colors.muted};
`

// Radix positions the content and sets the transform origin on the side of
// the button; the list inside grows from there.
const List = styled(m.div)`
    ${popoverSurface};
    min-width: max(var(--radix-select-trigger-width), ${({theme}) => theme.sizes.popover.minWidth});
    display: flex;
    flex-direction: column;
    max-height: var(--radix-select-content-available-height);
    transform-origin: var(--radix-select-content-transform-origin);
`

const Item = styled(RadixSelect.Item)`
    ${popoverItem};
    justify-content: space-between;
`

interface SelectProps<T extends string> {
    options: readonly SelectOption<T>[]
    value: T | undefined
    onValueChange: (value: T) => void
    /** The accessible name; inside a SettingsRow the row's label names it instead. */
    label?: string
    /** Shown while nothing is chosen. */
    placeholder?: string
    disabled?: boolean
    /** The options are still loading: a delayed spinner stands in for the caret. */
    pending?: boolean
}

/**
 * One choice from a list: a button showing the choice, and a list that opens
 * under it. Arrow keys, typing a name, Enter and Escape come from Radix.
 * The list looks like a Menu: it fades and grows from `SCALE_FROM` toward
 * the button over `fast`, shrinks back on close, and one highlight slides
 * between its rows.
 */
export function Select<T extends string>({
    options,
    value,
    onValueChange,
    label,
    placeholder,
    disabled,
    pending,
}: SelectProps<T>) {
    const theme = useTheme()
    const labelling = useControlLabelling(label)
    const [open, setOpen] = useState(false)
    // The list's rows share the menu's sliding highlight; Radix's viewport,
    // which scrolls, is their offset parent.
    const {handlers, highlight} = useSlidingHighlight('[role="option"]')
    // Radix unmounts a closed list at once, so it stays forced in while the
    // close plays. Closed, Radix keeps the items in a detached fragment, which
    // lets the button show the current label and select by typing; under
    // AnimatePresence they would be gone. A timer, not the animation's end,
    // releases it: a mounted list blocks pointer events on the page, so it
    // must never outlive the close, even if motion has not loaded.
    const [closing, setClosing] = useState(false)

    useEffect(() => {
        if (!closing) return
        const timer = setTimeout(() => setClosing(false), durations.fast)
        return () => clearTimeout(timer)
    }, [closing])

    const changeOpen = (next: boolean) => {
        setOpen(next)
        setClosing(!next)
    }

    return (
        <RadixSelect.Root
            value={value}
            onValueChange={(next) => onValueChange(next as T)}
            open={open}
            onOpenChange={changeOpen}
            disabled={disabled}
        >
            <Trigger {...labelling} aria-busy={pending || undefined}>
                <RadixSelect.Value placeholder={placeholder}/>
                <RadixSelect.Icon asChild>
                    {pending
                        ? <PendingMark><Spinner size={11} delayed/></PendingMark>
                        : <CaretDownIcon size={11} aria-hidden/>}
                </RadixSelect.Icon>
            </Trigger>
            <RadixSelect.Portal>
                <RadixSelect.Content
                    position="popper"
                    align="end"
                    sideOffset={px(theme.space[1])}
                    collisionPadding={px(theme.space[2])}
                    forceMount={open || closing ? true : undefined}
                >
                    <List
                        initial={{opacity: 0, scale: SCALE_FROM}}
                        animate={open ? {opacity: 1, scale: 1} : {opacity: 0, scale: SCALE_FROM}}
                        transition={tween('fast')}
                        {...handlers}
                    >
                        <RadixSelect.Viewport>
                            {highlight}
                            {options.map((option) => (
                                <Item key={option.value} value={option.value}>
                                    <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                                    <RadixSelect.ItemIndicator>
                                        <CheckIcon aria-hidden/>
                                    </RadixSelect.ItemIndicator>
                                </Item>
                            ))}
                        </RadixSelect.Viewport>
                    </List>
                </RadixSelect.Content>
            </RadixSelect.Portal>
        </RadixSelect.Root>
    )
}
