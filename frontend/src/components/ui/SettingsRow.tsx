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
import {searchTerms, settingsTextMatches, textOf} from './settingsSearch'
import {colorTransition} from './styles'
import {VisuallyHidden} from './VisuallyHidden'

// ---- Search ------------------------------------------------------------------------------
//
// Settings search finds rows by their own text, so no list of settings is
// kept by hand: inside a `SettingsSearchScope` every row checks its label,
// description, badge and value against the query. In `show` a row that
// does not match renders nothing and a group without a match hides; in
// `index` no row renders, and the scope only learns which rows match, so a
// subpage can be found by its rows without showing them. Rows report to
// their group and the group to the scope; a row that renders nothing stays
// mounted, so it can show again when the query changes.

interface SearchState {
    /** The query's words, lower case; a row matches when its text holds every one. */
    terms: string[]
    mode: 'show' | 'index'
    scope?: string
}

const SearchContext = createContext<SearchState | null>(null)

/** A row says whether it matches: its label when it does, null when not or when it unmounts. */
type MatchReport = (rowId: string, label: string | null) => void

const ReportContext = createContext<MatchReport | null>(null)

/**
 * Reports a row to its group and says whether it renders: always outside a
 * search, only when it matches in `show`, never in `index`.
 */
function useSearchMatch(label: string, ...parts: ReactNode[]): boolean {
    const search = useContext(SearchContext)
    const report = useContext(ReportContext)
    const rowId = useId()
    const text = parts.map(textOf).join(' ')
    const matches = search === null || settingsTextMatches(search.terms.join(' '), label, text)
    // Before paint, so a group never shows for a frame with rows that hide.
    useLayoutEffect(() => {
        if (!search || !report) return
        report(rowId, matches ? label : null)
        return () => report(rowId, null)
    }, [search, report, rowId, matches, label])
    return search === null || (matches && search.mode === 'show')
}

interface SettingsSearchScopeProps {
    /** What the user typed; blank shows every row as usual. */
    query: string
    /** `show` (the default) filters the rows in place; `index` renders none of them. */
    mode?: 'show' | 'index'
    /** Put before each group's title: "AI" turns "Summaries" into "AI · Summaries". */
    scope?: string
    /** The labels of the rows that match, in the order they mounted, whenever they change. */
    onMatches?: (labels: string[]) => void
    children: ReactNode
}

/** The rows and groups under it follow the query (see Search above). */
export function SettingsSearchScope({query, mode = 'show', scope, onMatches, children}: SettingsSearchScopeProps) {
    const key = searchTerms(query).join(' ')
    const search = useMemo<SearchState | null>(
        () => (key ? {terms: key.split(' '), mode, scope} : null),
        [key, mode, scope],
    )

    // Rows keep the place they first mounted in, which is the order they
    // appear in: re-reporting a row never moves it to the end.
    const order = useRef(new Map<string, number>())
    const matched = useRef(new Map<string, string>())
    const [labels, setLabels] = useState<string[]>([])
    const report = useCallback<MatchReport>((rowId, label) => {
        if (!order.current.has(rowId)) order.current.set(rowId, order.current.size)
        if (label === null) matched.current.delete(rowId)
        else matched.current.set(rowId, label)
        const next = [...matched.current.entries()]
            .sort(([a], [b]) => (order.current.get(a) ?? 0) - (order.current.get(b) ?? 0))
            .map(([, text]) => text)
        setLabels((previous) => (previous.length === next.length && previous.every((text, index) => text === next[index]) ? previous : next))
    }, [])

    const latest = useRef(onMatches)
    useLayoutEffect(() => {
        latest.current = onMatches
    })
    useLayoutEffect(() => {
        latest.current?.(labels)
    }, [labels])

    return (
        <SearchContext.Provider value={search}>
            <ReportContext.Provider value={search ? report : null}>{children}</ReportContext.Provider>
        </SearchContext.Provider>
    )
}

// ---- Groups ------------------------------------------------------------------------------

const Section = styled.section`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[1.5]};

    &[hidden] {
        display: none;
    }
`

const GroupTitle = styled.h2`
    padding: 0 ${({theme}) => theme.space[1]};
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
    color: ${({theme}) => theme.colors.muted};
`

// Rows sit on one grey card, divided by hairlines.
const cardStyles = css`
    overflow: hidden;
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.surface};

    > * + * {
        border-top: 1px solid ${({theme}) => theme.colors.border};
    }
`

const Card = styled.div`
    ${cardStyles};
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
    const parent = useContext(ReportContext)
    const rows = useRef(new Set<string>())
    const [matches, setMatches] = useState(0)
    const report = useCallback<MatchReport>((rowId, label) => {
        if (label === null) rows.current.delete(rowId)
        else rows.current.add(rowId)
        setMatches(rows.current.size)
        parent?.(rowId, label)
    }, [parent])

    const heading = search?.scope ? [search.scope, title].filter(Boolean).join(' · ') : title
    const labelled = heading ? titleId : undefined
    return (
        <ReportContext.Provider value={search ? report : null}>
            <Section aria-labelledby={labelled} hidden={search !== null && (matches === 0 || search.mode === 'index')}>
                {heading && <GroupTitle id={titleId}>{heading}</GroupTitle>}
                {card(labelled)}
                {note && !search && <Note>{note}</Note>}
            </Section>
        </ReportContext.Provider>
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

const Line = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
`

const Text = styled.span`
    display: flex;
    flex: 1;
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
    if (!useSearchMatch(label, description, badge)) return null

    return (
        <ControlLabelContext.Provider value={ids}>
            <Row>
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
    border: 0;
    background: transparent;
    font: inherit;
    cursor: pointer;
`

const NavButton = styled.button`
    ${rowButton};
    gap: ${({theme}) => theme.space[3]};
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
    color: ${({theme}) => theme.colors.text};
    ${colorTransition};

    &:hover {
        background: ${({theme}) => theme.colors.raised};
    }

    &:focus-visible {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: -2px;
    }

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
        <NavButton type="button" onClick={onClick}>
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

const RadioCard = styled(RadixRadio.Root)`
    ${cardStyles};
`

const RadioButton = styled(RadixRadio.Item)`
    ${rowButton};
    gap: ${({theme}) => theme.space[2.5]};
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
    color: ${({theme}) => theme.colors.text};
    ${colorTransition};

    &:hover:not(:disabled) {
        background: ${({theme}) => theme.colors.raised};
    }

    &:focus-visible {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: -2px;
    }

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

interface SettingsRadioGroupProps<T extends string> {
    /** The heading over the card, which also names the choice. */
    title: string
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
export function SettingsRadioGroup<T extends string>({title, note, value, onValueChange, disabled, children}: SettingsRadioGroupProps<T>) {
    return (
        <GroupFrame
            title={title}
            note={note}
            card={(titleId) => (
                <RadioCard
                    // Radix keeps '' for none; a value with no row leaves every row unchecked.
                    value={value ?? ''}
                    onValueChange={(next) => onValueChange(next as T)}
                    disabled={disabled}
                    aria-labelledby={titleId}
                    aria-label={titleId ? undefined : title}
                >
                    {children}
                </RadioCard>
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

/** One option of a `SettingsRadioGroup`. */
export function SettingsRadioRow({value, label, description, badge, disabled}: SettingsRadioRowProps) {
    const labelId = useId()
    const descriptionId = useId()
    if (!useSearchMatch(label, description, badge)) return null
    return (
        <RadioButton
            value={value}
            disabled={disabled}
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
