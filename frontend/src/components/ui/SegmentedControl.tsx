import {createContext, type KeyboardEvent, type ReactNode, useContext, useId, useRef} from 'react'
import {useMotionValue, useTransform} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {css} from 'styled-components'
import {springs} from '@/styles/motion'
import {Crossfade, CrossfadeView} from './Crossfade'
import {useInstantOnKey} from './instantOnKey'
import {focusRing} from './styles'

export interface SegmentedOption<T extends string> {
    value: T
    label: string
}

/**
 * segments: a compact radio group on the window, such as the theme switch;
 * tabs: a larger track of tabs over panels, such as Notes · Transcript ·
 * Summary.
 */
type Variant = 'segments' | 'tabs'

// The motion follows ddoemonn's Segmented Control on 21st.dev
// (https://21st.dev/@ddoemonn/components/segmented-control), rebuilt on the
// theme. Equal segments (the widest label sets them all) let the thumb move by
// transform alone: translateX(i × 100%) of its own width lands on segment i.

// Segments sit on the window with a border; tabs on a grey track whose
// transparent border keeps the same geometry. Both pad the thumb by 2 px.
// Never narrower than its labels: as a flex item it would shrink (its
// columns' minimum is 0) and the segments would run into each other.
const Track = styled.div<{ $count: number, $variant: Variant }>`
    position: relative;
    display: inline-grid;
    flex: none;
    grid-template-columns: repeat(${({$count}) => $count}, minmax(0, 1fr));
    width: max-content;
    min-width: max-content;
    padding: ${({theme}) => theme.space[0.5]};
    border: 1px solid;

    ${({$variant}) => $variant === 'segments' ? css`
        height: ${({theme}) => theme.sizes.control.sm};
        border-color: ${({theme}) => theme.colors.border};
        border-radius: ${({theme}) => theme.radii.sm};
        background: ${({theme}) => theme.colors.bg};
    ` : css`
        height: ${({theme}) => theme.sizes.control.md};
        border-color: transparent;
        border-radius: ${({theme}) => theme.radii.md};
        background: ${({theme}) => theme.colors.surface};
    `};
`

const segmentText = css<{ $variant: Variant }>`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 ${({theme, $variant}) => $variant === 'segments' ? theme.space[2.5] : theme.space[3]};
    ${({theme, $variant}) => $variant === 'segments' ? theme.text.small : theme.text.label};
    white-space: nowrap;
`

// Hover and press change the text colour alone; the thumb is the only filled
// shape, as in the reference. Keyboard focus draws an outline.
const segmentLook = css<{ $selected: boolean, $variant: Variant }>`
    position: relative;
    ${segmentText};
    margin: 0;
    border: 0;
    border-radius: ${({theme, $variant}) => $variant === 'segments' ? theme.radii.xs : theme.radii.sm};
    background: transparent;
    color: ${({theme}) => theme.colors.muted};
    cursor: pointer;
    user-select: none;
    transition: color ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};

    ${({$selected}) => !$selected && css`
        &:hover {
            color: ${({theme}) => theme.colors.text};
        }

        &:active {
            color: ${({theme}) => theme.colors.soft};
        }
    `}
`

// A native radio under each segment: arrow keys and focus come from the
// browser, and the shared `name` makes them one group. The radio fills its
// segment, so a screen reader's focus box outlines the whole segment; the
// thumb lies on top and lets the pointer through.
const Segment = styled.label<{ $selected: boolean, $variant: Variant }>`
    ${segmentLook};

    &:has(input:focus-visible) {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: 1px;
    }

    input {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        margin: 0;
        opacity: 0;
        pointer-events: none;
    }
`

const Tab = styled.button<{ $selected: boolean, $variant: Variant }>`
    ${segmentLook};
    ${focusRing};
`

const Thumb = styled(m.span)<{ $count: number, $variant: Variant }>`
    position: absolute;
    top: ${({theme}) => theme.space[0.5]};
    bottom: ${({theme}) => theme.space[0.5]};
    left: ${({theme}) => theme.space[0.5]};
    width: calc((100% - 2 * ${({theme}) => theme.space[0.5]}) / ${({$count}) => $count});
    overflow: hidden;
    border-radius: ${({theme, $variant}) => $variant === 'segments' ? theme.radii.xs : theme.radii.sm};
    background: ${({theme}) => theme.colors.raised};
    box-shadow: ${({theme}) => theme.shadows.raised};
    pointer-events: none;
`

// Inside the thumb, a copy of every label in the selected colour, moving the
// opposite way, so the copy stays over the labels below: the text under the
// thumb turns to the selected colour as the thumb slides across it.
const ThumbCopy = styled(m.span)`
    position: absolute;
    inset: 0;
`

const ThumbLabels = styled.span<{ $count: number, $variant: Variant }>`
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    display: grid;
    grid-template-columns: repeat(${({$count}) => $count}, minmax(0, 1fr));
    width: ${({$count}) => $count * 100}%;
    color: ${({theme}) => theme.colors.text};

    span {
        ${segmentText};
    }
`

interface SlidingThumbProps {
    at: number
    labels: readonly string[]
    variant: Variant
    /** The last change came from the keyboard: land at once, as the menus' highlight does. */
    instant: boolean
}

function SlidingThumb({at, labels, variant, instant}: SlidingThumbProps) {
    // The thumb's own offset drives its copy of the labels, so the two can
    // never drift apart, even when a new choice interrupts the spring.
    const thumbX = useMotionValue(`${at * 100}%`)
    const copyX = useTransform(thumbX, (offset) => `calc(${offset} * -1)`)

    return (
        <Thumb
            aria-hidden
            $count={labels.length}
            $variant={variant}
            style={{x: thumbX}}
            initial={false}
            animate={{x: `${at * 100}%`}}
            transition={instant ? {duration: 0} : springs.snappy}
        >
            <ThumbCopy style={{x: copyX}}>
                <ThumbLabels $count={labels.length} $variant={variant}>
                    {labels.map((label, i) => <span key={i}>{label}</span>)}
                </ThumbLabels>
            </ThumbCopy>
        </Thumb>
    )
}

const indexOf = <T extends string>(options: readonly SegmentedOption<T>[], value: T) =>
    Math.max(options.findIndex((option) => option.value === value), 0)

interface SegmentedControlProps<T extends string> {
    /** Names the group for assistive technology. */
    label: string
    options: readonly SegmentedOption<T>[]
    value: T
    onChange: (value: T) => void
}

/**
 * One choice out of a few, with a thumb that slides to it on
 * `springs.snappy`. Under reduced motion the thumb jumps (MotionProvider).
 * For views over panels, use Tabs: the same track as a tab list.
 */
export function SegmentedControl<T extends string>({label, options, value, onChange}: SegmentedControlProps<T>) {
    const name = useId()
    const {instant, handlers} = useInstantOnKey()

    return (
        <Track
            role="radiogroup"
            aria-label={label}
            $count={options.length}
            $variant="segments"
            {...handlers}
        >
            {options.map((option) => (
                <Segment key={option.value} $selected={option.value === value} $variant="segments">
                    <input
                        type="radio"
                        name={name}
                        value={option.value}
                        checked={option.value === value}
                        onChange={() => onChange(option.value)}
                    />
                    {option.label}
                </Segment>
            ))}
            <SlidingThumb
                at={indexOf(options, value)}
                labels={options.map((option) => option.label)}
                variant="segments"
                instant={instant}
            />
        </Track>
    )
}

interface TabsState {
    ids: string
    label: string
    options: readonly SegmentedOption<string>[]
    value: string
    onChange: (value: string) => void
}

const TabsContext = createContext<TabsState | null>(null)

function useTabs(part: string) {
    const tabs = useContext(TabsContext)
    if (!tabs) throw new Error(`${part} must be inside Tabs`)
    return tabs
}

const tabId = (ids: string, index: number) => `${ids}-tab-${index}`
const panelId = (ids: string, index: number) => `${ids}-panel-${index}`

interface TabsProps<T extends string> extends SegmentedControlProps<T> {
    /** Somewhere inside: one TabList and one TabPanels. */
    children: ReactNode
}

/**
 * Views over one area: a TabList (the segmented track) and TabPanels (the
 * view), placed anywhere inside. Arrow keys, Home and End move between tabs
 * and show each at once.
 */
export function Tabs<T extends string>({label, options, value, onChange, children}: TabsProps<T>) {
    const ids = useId()
    const state: TabsState = {ids, label, options, value, onChange: onChange as (value: string) => void}
    return <TabsContext.Provider value={state}>{children}</TabsContext.Provider>
}

const KEY_STEPS: Record<string, (at: number, count: number) => number> = {
    ArrowRight: (at, count) => (at + 1) % count,
    ArrowLeft: (at, count) => (at - 1 + count) % count,
    Home: () => 0,
    End: (_, count) => count - 1,
}

/** The tabs of the Tabs around it, on the segmented track. */
export function TabList() {
    const {ids, label, options, value, onChange} = useTabs('TabList')
    const buttons = useRef<(HTMLButtonElement | null)[]>([])
    const at = indexOf(options, value)
    const {instant, handlers} = useInstantOnKey()

    // Only the selected tab is in the Tab order; arrows move between them.
    const onKeyDown = (event: KeyboardEvent) => {
        // Any key, Enter and Space on a tab too: what it changes lands at once.
        handlers.onKeyDown()
        const step = KEY_STEPS[event.key]
        if (!step) return
        event.preventDefault()
        const next = step(at, options.length)
        onChange(options[next].value)
        buttons.current[next]?.focus()
    }

    return (
        <Track
            role="tablist"
            aria-label={label}
            $count={options.length}
            $variant="tabs"
            onKeyDown={onKeyDown}
            onPointerDown={handlers.onPointerDown}
        >
            {options.map((option, i) => (
                <Tab
                    key={option.value}
                    ref={(button) => {
                        buttons.current[i] = button
                    }}
                    type="button"
                    role="tab"
                    id={tabId(ids, i)}
                    aria-selected={i === at}
                    aria-controls={panelId(ids, i)}
                    tabIndex={i === at ? 0 : -1}
                    onClick={() => onChange(option.value)}
                    $selected={i === at}
                    $variant="tabs"
                >
                    {option.label}
                </Tab>
            ))}
            <SlidingThumb at={at} labels={options.map((option) => option.label)} variant="tabs" instant={instant}/>
        </Track>
    )
}

const Panel = styled(CrossfadeView)`
    overflow-y: auto;

    &:focus-visible {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: -2px;
    }
`

function TabPanel({index, ids, children}: { index: number, ids: string, children: ReactNode }) {
    return (
        <Panel role="tabpanel" id={panelId(ids, index)} aria-labelledby={tabId(ids, index)} tabIndex={0}>
            {children}
        </Panel>
    )
}

interface TabPanelsProps<T extends string> {
    /** Renders the view for a tab's value. */
    children: (value: T) => ReactNode
}

/** The view of the selected tab. A new view crossfades with the old over `base`, without sliding. */
export function TabPanels<T extends string>({children}: TabPanelsProps<T>) {
    const {ids, options, value} = useTabs('TabPanels')
    const at = indexOf(options, value)
    return (
        <Crossfade>
            <TabPanel key={value} index={at} ids={ids}>{children(value as T)}</TabPanel>
        </Crossfade>
    )
}
