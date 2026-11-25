import {
    type KeyboardEvent,
    memo,
    type ReactNode,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import {ArrowDownIcon, PencilSimpleIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {css} from 'styled-components'
import {Menu, MenuItem} from '@/components/ui/Menu'
import {colorTransition, fieldFocusRing, focusRing} from '@/components/ui/styles'
import {tween} from '@/styles/motion'
import {Veil} from '@/components/ui/Veil'
import {
    activeTurnIndex,
    displaySpeaker,
    formatClock,
    isUnnamedSpeaker,
    isUserSpeaker,
    joinTurns,
    speakerParts,
    type TranscriptLine,
    type Turn,
} from './turns'

/**
 * Where playback is, for the highlight. The player calls each listener with
 * the position in seconds as it moves; the list writes the highlight
 * straight to the row, so a long transcript does not render again on every
 * tick of the clock.
 */
export interface PlaybackClock {
    subscribe(listener: (seconds: number) => void): () => void
}

/** The voice of a turn, for the actions on it (`speakerActions`). */
export interface SpeakerTarget {
    /** The label as stored: "Speaker 2", "Priya Shah", "You", "A + B". */
    speaker: string
    /** Every line the turn joins, first to last; the first is the turn's id. */
    lineIds: readonly string[]
}

/** One entry of a voice's menu. */
export interface SpeakerAction {
    /** Unique within the menu. */
    id: string
    label: string
    /** A Phosphor `*Icon`. */
    icon?: ReactNode
    onSelect: () => void
}

export interface TranscriptListProps {
    lines: readonly TranscriptLine[]
    /** The region's accessible name: "Transcript", "Live transcript". */
    label: string
    /**
     * Lines are still arriving (#112's live transcript): the view follows
     * the end until the user scrolls up, and offers a way back down.
     */
    live?: boolean
    /** Shown with the user's own lines: "Jay (You)". */
    userName?: string
    /**
     * Tidies each turn's text for display (Labs › Clean transcript); the
     * saved text never changes. Runs whenever `lines` or `clean` change, so
     * pass a stable function.
     */
    clean?: (text: string) => string
    /**
     * Makes each time a button that plays from there. The list calls the
     * latest one; an inline function renders no row again.
     */
    onSeek?: (seconds: number) => void
    /**
     * Makes each single voice other than the user's a button that names it
     * on every line of the meeting. Reject to keep the field open; the
     * caller says why. Called like `onSeek`, the latest one.
     */
    onRenameSpeaker?: (from: string, to: string) => Promise<unknown>
    /**
     * The actions on a voice, offered in a menu from its label: opening its
     * contact (#118), Who said this (#119). With `onRenameSpeaker` the menu
     * ends with Rename speaker; a voice with no action but the rename starts
     * it from the label at once. Called as each row renders, so pass a
     * stable function: a new one renders every row again.
     */
    speakerActions?: (target: SpeakerTarget) => readonly SpeakerAction[]
    /** Highlights the turn being played. */
    playback?: PlaybackClock
    /** While true, the highlighted turn is kept in view unless the user scrolled a moment ago. */
    followPlayback?: boolean
    /** Shown instead of the rows while there are none. */
    empty?: ReactNode
    /** Above the first row, such as a note that the text is still provisional. */
    before?: ReactNode
    /** Under the last row, such as "Listening…". */
    after?: ReactNode
}

/** Within this many pixels of the end, a live list counts as following it. */
const END_SLACK = 24

/** After the user scrolls, following playback waits this long before it scrolls again. */
const USER_SCROLL_HOLD_MS = 4000

const Scroller = styled.div`
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2]} ${({theme}) => theme.space[3]};
    outline: none;

    &:focus-visible {
        ${fieldFocusRing};
    }
`

const Rows = styled.ol<{ $longTimes: boolean }>`
    --transcript-time: ${({theme, $longTimes}) => ($longTimes ? theme.sizes.transcript.timeLong : theme.sizes.transcript.time)};
    margin: 0;
    padding: 0;
    list-style: none;
`

// Rows off screen are neither laid out nor painted (content-visibility), so
// a meeting of several hours costs about what its visible rows cost; until a
// row is first drawn it is taken to be `rowEstimate` tall, then the browser
// remembers its height.
const rowStyle = css`
    display: grid;
    grid-template-columns: var(--transcript-time) minmax(0, 1fr);
    column-gap: ${({theme}) => theme.space[1.5]};
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[2]} ${({theme}) => theme.space[1.5]};
    border-radius: ${({theme}) => theme.radii.md};
    content-visibility: auto;
    contain-intrinsic-size: auto ${({theme}) => theme.sizes.transcript.rowEstimate};
    ${colorTransition};

    /* The turn being played, set by the playback clock (see PlaybackClock). */
    &[data-active] {
        background: ${({theme}) => theme.colors.surface};
    }
`

const Row = styled.li`
    ${rowStyle};
`

const ArrivingRow = styled(m.li)`
    ${rowStyle};
    position: relative;
`

const timeStyle = css`
    align-self: start;
    height: ${({theme}) => theme.space[5]};
    padding: 0 ${({theme}) => theme.space[1]};
    font-family: ${({theme}) => theme.fonts.mono};
    ${({theme}) => theme.text.caption};
    line-height: ${({theme}) => theme.space[5]};
    font-variant-numeric: tabular-nums;
    color: ${({theme}) => theme.colors.muted};
`

const Time = styled.span`
    ${timeStyle};
`

const SeekButton = styled.button`
    ${timeStyle};
    margin: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: transparent;
    text-align: left;
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    &:hover {
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.text};
    }

    [data-active] &:hover {
        background: ${({theme}) => theme.colors.raised};
    }
`

const Speaker = styled.span`
    display: block;
    ${({theme}) => theme.text.label};
    line-height: ${({theme}) => theme.space[5]};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
`

const SpeakerButton = styled.button<{ $unnamed: boolean }>`
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: none;
    color: ${({theme}) => theme.colors.text};
    font: inherit;
    text-decoration: ${({$unnamed}) => ($unnamed ? 'underline dotted' : 'none')};
    text-underline-offset: ${({theme}) => theme.space[0.5]};
    cursor: pointer;
    ${focusRing};

    &:hover {
        text-decoration: underline;
    }
`

const NameInput = styled.input`
    width: 100%;
    height: ${({theme}) => theme.space[5]};
    margin: 0;
    padding: 0 ${({theme}) => theme.space[1]};
    border: 1px solid ${({theme}) => theme.colors.text};
    border-radius: ${({theme}) => theme.radii.xs};
    background: ${({theme}) => theme.colors.raised};
    color: ${({theme}) => theme.colors.text};
    ${({theme}) => theme.text.label};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
    ${fieldFocusRing};

    &::placeholder {
        color: ${({theme}) => theme.colors.muted};
        font-weight: ${({theme}) => theme.fontWeights.regular};
    }
`

const Text = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.soft};
    overflow-wrap: anywhere;
    ${colorTransition};

    [data-active] > div > & {
        color: ${({theme}) => theme.colors.text};
    }
`

// Sticks to the bottom of the view while the user reads back up.
const Latest = styled(m.button)`
    position: sticky;
    bottom: 0;
    display: flex;
    width: fit-content;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    height: ${({theme}) => theme.sizes.control.sm};
    margin: ${({theme}) => theme.space[2]} auto 0;
    padding: 0 ${({theme}) => theme.space[2.5]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.pill};
    background: ${({theme}) => theme.colors.raised};
    box-shadow: ${({theme}) => theme.shadows.popover};
    color: ${({theme}) => theme.colors.text};
    ${({theme}) => theme.text.label};
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    &:hover {
        background: ${({theme}) => theme.colors.surface};
    }
`

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The field that names a voice, in place of its label. */
function RenameField({from, onSubmit, onDone}: {
    from: string
    onSubmit: (from: string, to: string) => Promise<unknown>
    onDone: () => void
}) {
    const [value, setValue] = useState(isUnnamedSpeaker(from) ? '' : from)
    const pending = useRef(false)

    const submit = async () => {
        const to = value.trim()
        if (pending.current) return
        if (!to || to === from) {
            onDone()
            return
        }
        pending.current = true
        try {
            await onSubmit(from, to)
            onDone()
        } catch {
            // The caller told the user why; the field stays for another try.
            pending.current = false
        }
    }

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault()
            void submit()
        } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onDone()
        }
    }

    return (
        <NameInput
            autoFocus
            value={value}
            placeholder="Name"
            aria-label={`Name ${from}`}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => void submit()}
        />
    )
}

/** What every row shares and never changes: the list's own stable functions. */
interface RowActions {
    seek: (seconds: number) => void
    rename: (from: string, to: string) => Promise<unknown>
    edit: (turnId: string | null) => void
    register: (turnId: string, element: HTMLElement | null) => void
}

interface TurnRowProps {
    turn: Turn
    /** Fades in: a line that arrived while the list was live. */
    arriving: boolean
    userName?: string
    editing: boolean
    canSeek: boolean
    canRename: boolean
    speakerActions?: TranscriptListProps['speakerActions']
    actions: RowActions
}

const TurnRow = memo(function TurnRow({turn, arriving, userName, editing, canSeek, canRename, speakerActions, actions}: TurnRowProps) {
    const speaker = turn.speaker
    const time = turn.start === null ? null : formatClock(turn.start)
    // A single voice can be named here; the user's own and overlapping ones cannot.
    const renameable = canRename && !!speaker && !isUserSpeaker(speaker) && speakerParts(speaker).length === 1

    const menu = speaker && speakerActions ? speakerActions({speaker, lineIds: turn.lineIds}) : []

    let name: ReactNode = null
    if (speaker && editing && renameable) {
        name = <RenameField from={speaker} onSubmit={actions.rename} onDone={() => actions.edit(null)}/>
    } else if (speaker && menu.length > 0) {
        name = (
            <Menu
                align="start"
                trigger={(
                    <SpeakerButton type="button" data-speaker="" $unnamed={isUnnamedSpeaker(speaker)}>
                        {displaySpeaker(speaker, userName)}
                    </SpeakerButton>
                )}
            >
                {menu.map((action) => (
                    <MenuItem key={action.id} icon={action.icon} onSelect={action.onSelect}>{action.label}</MenuItem>
                ))}
                {renameable && (
                    <MenuItem icon={<PencilSimpleIcon/>} onSelect={() => actions.edit(turn.id)}>Rename speaker</MenuItem>
                )}
            </Menu>
        )
    } else if (speaker && renameable) {
        name = (
            <SpeakerButton
                type="button"
                data-speaker=""
                $unnamed={isUnnamedSpeaker(speaker)}
                aria-label={`Name ${speaker}`}
                title="Rename speaker"
                onClick={() => actions.edit(turn.id)}
            >
                {speaker}
            </SpeakerButton>
        )
    } else if (speaker) {
        name = displaySpeaker(speaker, userName)
    }

    const content = (
        <>
            {time === null
                ? <span/>
                : canSeek && turn.start !== null
                    ? <SeekButton type="button" aria-label={`Play from ${time}`} title="Play from here" onClick={() => actions.seek(turn.start!)}>{time}</SeekButton>
                    : <Time>{time}</Time>}
            <div>
                {name && <Speaker>{name}</Speaker>}
                <Text>{turn.text}</Text>
            </div>
        </>
    )
    const ref = (element: HTMLElement | null) => actions.register(turn.id, element)

    return arriving
        ? <ArrivingRow ref={ref} initial={{y: 4}} animate={{y: 0}} transition={tween('base', 'enter')}>{content}<Veil/></ArrivingRow>
        : <Row ref={ref}>{content}</Row>
}, (before, after) =>
    // Turns are rebuilt whenever lines change; compare what a row shows, so
    // only the rows that changed render again as a live transcript grows.
    // `actions` never changes.
    before.turn.id === after.turn.id &&
    before.turn.start === after.turn.start &&
    before.turn.speaker === after.turn.speaker &&
    before.turn.text === after.turn.text &&
    before.arriving === after.arriving &&
    before.userName === after.userName &&
    before.editing === after.editing &&
    before.canSeek === after.canSeek &&
    before.canRename === after.canRename &&
    before.speakerActions === after.speakerActions)

/**
 * A transcript, saved or live: one row per turn with its time, the voice
 * and what was said. Consecutive lines of one voice join into one turn.
 * Rows off screen are skipped by the browser, the playing turn is marked
 * without rendering the list again, and a live transcript follows its end
 * until the user scrolls up. The list is its own scroll container: give it
 * a parent with a height.
 */
export function TranscriptList({
    lines,
    label,
    live = false,
    userName,
    clean,
    onSeek,
    onRenameSpeaker,
    speakerActions,
    playback,
    followPlayback = false,
    empty,
    before,
    after,
}: TranscriptListProps) {
    const turns = useMemo(() => {
        const joined = joinTurns(lines)
        return clean ? joined.map((turn) => ({...turn, text: clean(turn.text) || turn.text})) : joined
    }, [lines, clean])
    const scroller = useRef<HTMLDivElement>(null)
    const rows = useRef(new Map<string, HTMLElement>())
    const [editing, setEditing] = useState<string | null>(null)
    const refocus = useRef<string | null>(null)

    // Rows present at the first render arrive with the screen; a line that
    // arrives later while the list is live fades in on its own. Once it has,
    // it stays the same element: #112 turns `live` off after Stop on the
    // same list, and a row that changed element type would mount again.
    const [initialIds] = useState(() => new Set(turns.map((turn) => turn.id)))
    const [arrived] = useState(() => new Set<string>())
    if (live) {
        for (const turn of turns) if (!initialIds.has(turn.id)) arrived.add(turn.id)
    }

    // The callers' functions, kept current without rendering a row again.
    const callbacks = useRef({onSeek, onRenameSpeaker})
    useLayoutEffect(() => {
        callbacks.current = {onSeek, onRenameSpeaker}
    })
    const [actions] = useState<RowActions>(() => ({
        seek: (seconds) => callbacks.current.onSeek?.(seconds),
        rename: (from, to) => callbacks.current.onRenameSpeaker?.(from, to) ?? Promise.resolve(),
        edit: (turnId) => {
            setEditing((current) => {
                if (turnId === null) refocus.current = current
                return turnId
            })
        },
        register: (turnId, element) => {
            if (element) rows.current.set(turnId, element)
            else rows.current.delete(turnId)
        },
    }))

    // Back on the voice's button after naming it, or after Escape.
    useLayoutEffect(() => {
        if (editing !== null || refocus.current === null) return
        rows.current.get(refocus.current)?.querySelector<HTMLElement>('[data-speaker]')?.focus()
        refocus.current = null
    }, [editing])

    // ---- The playing turn --------------------------------------------------
    const turnsRef = useRef(turns)
    const activeId = useRef<string | null>(null)
    const follow = useRef(followPlayback)
    const lastUserScroll = useRef(0)
    useLayoutEffect(() => {
        turnsRef.current = turns
        follow.current = followPlayback
        // A row that mounted again since the last tick gets its mark back.
        const row = activeId.current ? rows.current.get(activeId.current) : undefined
        if (row && !row.hasAttribute('data-active')) {
            row.setAttribute('data-active', '')
            row.setAttribute('aria-current', 'true')
        }
    })

    useEffect(() => {
        if (!playback) return
        // One Map for the list's life; rows add and remove themselves.
        const rowMap = rows.current
        const unsubscribe = playback.subscribe((seconds) => {
            const list = turnsRef.current
            const index = activeTurnIndex(list, seconds)
            const id = index >= 0 ? list[index].id : null
            if (id === activeId.current) return
            const previous = activeId.current ? rowMap.get(activeId.current) : undefined
            previous?.removeAttribute('data-active')
            previous?.removeAttribute('aria-current')
            activeId.current = id
            const row = id ? rowMap.get(id) : undefined
            if (!row) return
            row.setAttribute('data-active', '')
            row.setAttribute('aria-current', 'true')
            const box = scroller.current
            if (!follow.current || !box || Date.now() - lastUserScroll.current < USER_SCROLL_HOLD_MS) return
            const view = box.getBoundingClientRect()
            const place = row.getBoundingClientRect()
            if (place.top < view.top || place.bottom > view.bottom) {
                row.scrollIntoView?.({block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth'})
            }
        })
        return () => {
            unsubscribe()
            const row = activeId.current ? rowMap.get(activeId.current) : undefined
            row?.removeAttribute('data-active')
            row?.removeAttribute('aria-current')
            activeId.current = null
        }
    }, [playback])

    // ---- Following a live end ----------------------------------------------
    const atEnd = useRef(true)
    const [showLatest, setShowLatest] = useState(false)

    const onScroll = () => {
        const box = scroller.current
        if (!box) return
        atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight <= END_SLACK
        setShowLatest(live && !atEnd.current)
    }

    useLayoutEffect(() => {
        const box = scroller.current
        if (!live || !box || !atEnd.current) return
        box.scrollTop = box.scrollHeight
        // Rows drawn for the first time replace their estimated height; land
        // on the real end once they have.
        const frame = requestAnimationFrame(() => {
            if (atEnd.current) box.scrollTop = box.scrollHeight
        })
        return () => cancelAnimationFrame(frame)
    }, [turns, live])

    const toLatest = () => {
        const box = scroller.current
        if (!box) return
        atEnd.current = true
        setShowLatest(false)
        box.scrollTo?.({top: box.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth'})
    }

    const userScrolled = () => {
        lastUserScroll.current = Date.now()
    }

    const longTimes = turns.some((turn) => (turn.start ?? 0) >= 3600)

    return (
        <Scroller
            ref={scroller}
            role="region"
            aria-label={label}
            tabIndex={0}
            onScroll={onScroll}
            onWheel={userScrolled}
            onTouchMove={userScrolled}
            onKeyDown={userScrolled}
        >
            {before}
            {turns.length === 0 ? empty : (
                <Rows $longTimes={longTimes}>
                    {turns.map((turn) => (
                        <TurnRow
                            key={turn.id}
                            turn={turn}
                            arriving={arrived.has(turn.id)}
                            userName={userName}
                            editing={editing === turn.id}
                            canSeek={!!onSeek}
                            canRename={!!onRenameSpeaker}
                            speakerActions={speakerActions}
                            actions={actions}
                        />
                    ))}
                </Rows>
            )}
            {after}
            <AnimatePresence>
                {showLatest && (
                    <Latest
                        type="button"
                        initial={{opacity: 0, y: 4}}
                        animate={{opacity: 1, y: 0}}
                        exit={{opacity: 0, y: 4}}
                        transition={tween('fast')}
                        onClick={toLatest}
                    >
                        <ArrowDownIcon aria-hidden="true"/>
                        Latest
                    </Latest>
                )}
            </AnimatePresence>
        </Scroller>
    )
}
