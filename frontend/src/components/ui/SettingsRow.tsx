import {
    createContext,
    type ReactNode,
    useCallback,
    useContext,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import {ArrowSquareOutIcon, CaretRightIcon} from '@phosphor-icons/react'
import * as RadixRadio from '@radix-ui/react-radio-group'
import styled, {css} from 'styled-components'
import {MOTION_OK} from '@/styles/motion'
import {ControlLabelContext} from './controlLabelling'
import {matchesTerms, searchTerms} from './settingsSearch'
import {colorTransition, fieldFocusRing} from './styles'
import {VisuallyHidden} from './VisuallyHidden'

// ---- Search ------------------------------------------------------------------------------
//
// Settings search finds rows by their own text, so no list of settings is
// kept by hand: inside a `SettingsSearchScope` every row checks its label,
// string description, badge and value against the query. A row that does
// not match renders nothing, so its control remounts when it shows again;
// the row itself keeps listening, so it comes back when the query changes.
// A group with no row left hides by CSS (`:has()`), and the scope counts
// the rows that match for "Nothing matches".

interface SearchState {
    /** The query's words, lower case; a row matches when its text holds every one. */
    terms: string[]
    scope?: string
}

const SearchContext = createContext<SearchState | null>(null)

/** A row says whether it matches; false also when it unmounts. */
type MatchReport = (rowId: string, matches: boolean) => void

const ReportContext = createContext<MatchReport | null>(null)

/** Reports a row to the scope and says whether it renders: always outside a search, else only when it matches. */
function useSearchMatch(...parts: (string | undefined)[]): boolean {
    const search = useContext(SearchContext)
    const report = useContext(ReportContext)
    const rowId = useId()
    const matches = search === null || matchesTerms(search.terms, ...parts)
    useLayoutEffect(() => {
        if (!search || !report) return
        report(rowId, matches)
        return () => report(rowId, false)
    }, [search, report, rowId, matches])
    return matches
}

/** Only a string description is searched; a StatusLine's text is not in its children. */
const plain = (node: ReactNode) => (typeof node === 'string' ? node : undefined)

interface SettingsSearchScopeProps {
    /** What the user typed; blank shows every row as usual. */
    query: string
    /** Put before each group's title: "AI" turns "Summaries" into "AI · Summaries". */
    scope?: string
    /** How many rows match, whenever that changes. */
    onMatches?: (count: number) => void
    children: ReactNode
}

/** The rows and groups under it follow the query (see Search above). */
export function SettingsSearchScope({query, scope, onMatches, children}: SettingsSearchScopeProps) {
    const key = searchTerms(query).join(' ')
    const search = useMemo<SearchState | null>(() => (key ? {terms: key.split(' '), scope} : null), [key, scope])

    const matched = useRef(new Set<string>())
    const [count, setCount] = useState(0)
    const report = useCallback<MatchReport>((rowId, matches) => {
        if (matches) matched.current.add(rowId)
        else matched.current.delete(rowId)
        setCount(matched.current.size)
    }, [])

    const latest = useRef(onMatches)
    useLayoutEffect(() => {
        latest.current = onMatches
    })
    // Before paint, so "Nothing matches" never shows for a frame over rows.
    useLayoutEffect(() => {
        latest.current?.(count)
    }, [count])

    return (
        <SearchContext.Provider value={search}>
            <ReportContext.Provider value={search ? report : null}>{children}</ReportContext.Provider>
        </SearchContext.Provider>
    )
}

// ---- Groups ------------------------------------------------------------------------------

const Section = styled.section<{$searching: boolean}>`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[1.5]};

    ${({$searching}) => $searching && css`
        &:not(:has([data-settings-row])) {
            display: none;
        }
    `}
`

const GroupTitle = styled.h2`
    padding: 0 ${({theme}) => theme.space[1]};
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
    color: ${({theme}) => theme.colors.muted};
`

// Rows sit on one grey card, divided by hairlines. A row that search hides
// leaves an empty wrapper behind (a Collapse), which takes no line. The
// card's colour is behind the veils of what swaps on it (Veil).
const Card = styled.div`
    --surface: ${({theme}) => theme.colors.surface};
    overflow: hidden;
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.surface};

    > :not(:empty) ~ :not(:empty) {
        border-top: 1px solid ${({theme}) => theme.colors.border};
    }
`

const Note = styled.p`
    padding: 0 ${({theme}) => theme.space[1]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

interface SettingsGroupProps {
    /** A small heading over the card; also names the group. */
    title?: string
    /** A line under the card. */
    note?: string
    children: ReactNode
}

/**
 * A group's frame, and inside a search what it needs of it: the scope
 * before its title, hidden while none of its rows match, no note (it
 * speaks of the rows around it).
 */
function GroupFrame({title, note, card}: {title?: string, note?: string, card: (titleId?: string) => ReactNode}) {
    const titleId = useId()
    const search = useContext(SearchContext)
    const heading = search?.scope ? [search.scope, title].filter(Boolean).join(' · ') : title
    const labelled = heading ? titleId : undefined
    return (
        <Section aria-labelledby={labelled} $searching={search !== null}>
            {heading && <GroupTitle id={titleId}>{heading}</GroupTitle>}
            {card(labelled)}
            {note && !search && <Note>{note}</Note>}
        </Section>
    )
}

/** Settings rows on one card, with an optional heading above and a note below. */
export function SettingsGroup({title, note, children}: SettingsGroupProps) {
    return <GroupFrame title={title} note={note} card={() => <Card>{children}</Card>}/>
}

// ---- Rows --------------------------------------------------------------------------------

const Row = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
`

// A control too wide to leave the text 160 px drops to its own line, rather
// than squeezing the label to a word per line (Theme's three segments).
const Line = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[3]};
`

const Text = styled.span`
    display: flex;
    flex: 1 1 160px;
    flex-direction: column;
    min-width: 0;
    text-align: left;
`

const Label = styled.span`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.text};
`

const Description = styled.span`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Badge = styled.span`
    flex: none;
    padding: 0 ${({theme}) => theme.space[1]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.xs};
    ${({theme}) => theme.text.caption};
    color: ${({theme}) => theme.colors.muted};
`

interface SettingsRowProps {
    label: string
    /** A line under the label; a StatusLine there animates a status that changes. */
    description?: ReactNode
    /** A short tag after the label, such as "Labs". */
    badge?: string
    /**
     * The control on the right: a Switch, a Select, a small TextField or
     * Buttons. A Switch, Select or field without a label of its own is named
     * by the row's label and described by its description.
     */
    control?: ReactNode
    /** Content under the label that takes the row's width: a slider, a text area, a progress bar. */
    children?: ReactNode
}

/** One setting: its label and description, its control on the right, and anything wide below. */
export function SettingsRow({label, description, badge, control, children}: SettingsRowProps) {
    const labelId = useId()
    const descriptionId = useId()
    const ids = useMemo(
        () => ({labelId, descriptionId: description ? descriptionId : undefined}),
        [labelId, descriptionId, description],
    )
    if (!useSearchMatch(label, plain(description), badge)) return null

    return (
        <ControlLabelContext.Provider value={ids}>
            <Row data-settings-row={label}>
                <Line>
                    <Text>
                        <Label>
                            <span id={labelId}>{label}</span>
                            {badge && <Badge>{badge}</Badge>}
                        </Label>
                        {description && <Description id={descriptionId}>{description}</Description>}
                    </Text>
                    {control}
                </Line>
                {children}
            </Row>
        </ControlLabelContext.Provider>
    )
}

// A row-wide button: a subpage, a link, a radio. Inside the card's rounded
// clip an outset outline would be cut off, so focus draws inside.
const rowButton = css`
    display: flex;
    align-items: center;
    width: 100%;
    margin: 0;
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
    border: 0;
    background: transparent;
    color: ${({theme}) => theme.colors.text};
    font: inherit;
    cursor: pointer;
    ${colorTransition};

    &:hover:not(:disabled) {
        background: ${({theme}) => theme.colors.raised};
    }

    &:focus-visible {
        ${fieldFocusRing};
    }
`

const NavButton = styled.button`
    ${rowButton};
    gap: ${({theme}) => theme.space[3]};

    > svg {
        flex: none;
        color: ${({theme}) => theme.colors.muted};
    }
`

const Value = styled.span`
    max-width: ${({theme}) => theme.sizes.popover.triggerMaxWidth};
    overflow: hidden;
    ${({theme}) => theme.text.label};
    font-weight: ${({theme}) => theme.fontWeights.regular};
    color: ${({theme}) => theme.colors.muted};
    text-overflow: ellipsis;
    white-space: nowrap;
`

interface SettingsNavRowProps {
    label: string
    description?: string
    /** The current value, shown before the arrow. */
    value?: string
    /** Opens something outside the app (a web page) instead of a subpage. */
    external?: boolean
    onClick: () => void
}

/** A row that opens a subpage, or a page outside the app, showing the current value. */
export function SettingsNavRow({label, description, value, external = false, onClick}: SettingsNavRowProps) {
    if (!useSearchMatch(label, description, value)) return null
    return (
        <NavButton type="button" onClick={onClick} data-settings-row={label}>
            <Text>
                <Label>
                    {label}
                    {/* The arrow says it to the eye. */}
                    {external && <VisuallyHidden> (opens in browser)</VisuallyHidden>}
                </Label>
                {description && <Description>{description}</Description>}
            </Text>
            {value && <Value>{value}</Value>}
            {external ? <ArrowSquareOutIcon size={12} aria-hidden/> : <CaretRightIcon size={11} aria-hidden/>}
        </NavButton>
    )
}

// ---- Radio rows --------------------------------------------------------------------------

const RadioButton = styled(RadixRadio.Item)`
    ${rowButton};
    gap: ${({theme}) => theme.space[2.5]};

    &:disabled {
        cursor: default;
        opacity: 0.5;
    }
`

// The ring takes the text colour when chosen; the dot grows into it.
const Ring = styled.span`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: ${({theme}) => theme.sizes.radio.size};
    height: ${({theme}) => theme.sizes.radio.size};
    border: ${({theme}) => theme.sizes.radio.ring} solid ${({theme}) => theme.colors.muted};
    border-radius: ${({theme}) => theme.radii.pill};
    ${colorTransition};

    [data-state='checked'] > & {
        border-color: ${({theme}) => theme.colors.text};
    }
`

const Dot = styled(RadixRadio.Indicator)`
    width: ${({theme}) => theme.sizes.radio.dot};
    height: ${({theme}) => theme.sizes.radio.dot};
    border-radius: ${({theme}) => theme.radii.pill};
    background: ${({theme}) => theme.colors.text};
    opacity: 0;
    transition: opacity ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};

    &[data-state='checked'] {
        opacity: 1;
    }

    ${MOTION_OK} {
        transform: scale(0.5);
        transition-property: opacity, transform;

        &[data-state='checked'] {
            transform: none;
        }
    }
`

// Tiles three to a row, the chosen one outlined (Export's format, a
// transcript's voices); the same Radix item as a row.
const RadioGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: ${({theme}) => theme.space[1.5]};
`

const RadioTile = styled(RadixRadio.Item)`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[0.5]};
    min-width: 0;
    margin: 0;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.raised};
    color: ${({theme}) => theme.colors.text};
    font: inherit;
    text-align: left;
    cursor: pointer;
    ${colorTransition};

    &:focus-visible {
        ${fieldFocusRing};
    }

    &:hover:not(:disabled) {
        background: ${({theme}) => theme.colors.surface};
    }

    &[data-state='checked'] {
        border-color: ${({theme}) => theme.colors.text};
        background: ${({theme}) => theme.colors.surface};
    }

    &:disabled {
        cursor: default;
        opacity: 0.5;
    }

    > span {
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
`

/** `card`: rows on a settings card; `grid`: tiles three to a row. */
export type RadioLayout = 'card' | 'grid'

const RadioLayoutContext = createContext<RadioLayout>('card')

interface SettingsRadioGroupProps<T extends string> {
    /** The heading over the card, which also names the choice. */
    title: string
    layout?: RadioLayout
    note?: string
    /** The chosen value; none is chosen while it is undefined or matches no row. */
    value: T | undefined
    onValueChange: (value: T) => void
    disabled?: boolean
    /** `SettingsRadioRow`s. */
    children: ReactNode
}

/**
 * One choice among rows, such as a provider or the default template: a
 * group whose card is a radio group. Arrow keys move between the rows and
 * choose as they go; Tab enters at the chosen row.
 */
export function SettingsRadioGroup<T extends string>({title, layout = 'card', note, value, onValueChange, disabled, children}: SettingsRadioGroupProps<T>) {
    const Frame = layout === 'grid' ? RadioGrid : Card
    return (
        <GroupFrame
            title={title}
            note={note}
            card={(titleId) => (
                <RadixRadio.Root
                    asChild
                    // Radix keeps '' for none; a value with no row leaves every row unchecked.
                    value={value ?? ''}
                    onValueChange={(next) => onValueChange(next as T)}
                    disabled={disabled}
                    aria-labelledby={titleId}
                >
                    <Frame>
                        <RadioLayoutContext.Provider value={layout}>{children}</RadioLayoutContext.Provider>
                    </Frame>
                </RadixRadio.Root>
            )}
        />
    )
}

interface SettingsRadioRowProps {
    value: string
    label: string
    description?: string
    /** A short tag at the end, such as "Recommended". */
    badge?: string
    disabled?: boolean
}

/** One option of a `SettingsRadioGroup`: a row, or a tile in the grid layout. */
export function SettingsRadioRow({value, label, description, badge, disabled}: SettingsRadioRowProps) {
    const labelId = useId()
    const descriptionId = useId()
    const layout = useContext(RadioLayoutContext)
    if (!useSearchMatch(label, description, badge)) return null
    if (layout === 'grid') {
        return (
            <RadioTile value={value} disabled={disabled} aria-labelledby={labelId} aria-describedby={description ? descriptionId : undefined}>
                <Label id={labelId}>{label}</Label>
                {description && <Description id={descriptionId}>{description}</Description>}
            </RadioTile>
        )
    }
    return (
        <RadioButton
            value={value}
            disabled={disabled}
            data-settings-row={label}
            aria-labelledby={labelId}
            aria-describedby={description ? descriptionId : undefined}
        >
            <Ring>
                <Dot forceMount/>
            </Ring>
            <Text>
                <Label id={labelId}>{label}</Label>
                {description && <Description id={descriptionId}>{description}</Description>}
            </Text>
            {badge && <Badge>{badge}</Badge>}
        </RadioButton>
    )
}
