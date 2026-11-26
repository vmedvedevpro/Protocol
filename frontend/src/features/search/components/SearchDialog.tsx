import {type ReactNode, useEffect, useMemo, useRef, useState} from 'react'
import {
    CheckCircleIcon,
    CheckIcon,
    FileTextIcon,
    FolderIcon,
    GearIcon,
    MagnifyingGlassIcon,
    MonitorIcon,
    MoonIcon,
    NotePencilIcon,
    SunIcon,
    UserIcon,
    UsersIcon,
    WaveformIcon,
} from '@phosphor-icons/react'
import {useQuery} from '@tanstack/react-query'
import {Command} from 'cmdk'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {foldersQuery, meetingsQuery} from '@/api/meetings'
import {type Person, peopleQuery} from '@/api/people'
import {formatClock} from '@/components/transcript/turns'
import {Kbd} from '@/components/ui/Kbd'
import {Sheet} from '@/components/ui/Sheet'
import {Spinner} from '@/components/ui/Spinner'
import {VisuallyHidden} from '@/components/ui/VisuallyHidden'
import {headerWhen, parseDate} from '@/lib/dates'
import {useHotkey} from '@/lib/hotkeys'
import {paths} from '@/lib/paths'
import {formatShortcut} from '@/lib/platform'
import {closeSearch, openSearch, useSearchLauncher} from '@/lib/searchLauncher'
import {markdownSnippetText} from '@/lib/summaryMarkdown'
import {THEME_MODES, type ThemeMode, useThemeModeStore} from '@/styles/themeMode'
import {MIN_QUERY_LENGTH, type SearchResult, type SearchResultKind, searchQuery} from '../api/search'

/** Something search can do besides opening a result. */
export interface SearchCommand {
    id: string
    label: string
    /** Other words that find it. */
    keywords?: string
    /** A Phosphor `*Icon`. */
    icon: ReactNode
    /** The hotkey that does the same, from `formatShortcut`. */
    shortcut?: string
    /** Where it is listed; the caller's commands are Actions. */
    group?: 'Actions' | 'Go to' | 'Theme'
    /** Runs with the dialog still open, as a theme does, so the next can be tried. */
    keepOpen?: boolean
    run: () => void
}

/** How long typing must pause before the library is searched; the old dialog's wait. */
export const SEARCH_DEBOUNCE_MS = 220

/** `value`, once it has stayed the same for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
    const [settled, setSettled] = useState(value)
    useEffect(() => {
        const timer = setTimeout(() => setSettled(value), ms)
        return () => clearTimeout(timer)
    }, [value, ms])
    return settled
}

const RECENT_MEETINGS = 5

/**
 * Contacts the empty dialog lists after the recent meetings: fewer than
 * them, so the commands below stay in reach; "Show all people" lists the rest.
 */
const PEOPLE_PREVIEW = 4

const GROUP_TITLES: Record<SearchResultKind, string> = {
    meeting: 'Meetings',
    action: 'Action items',
    transcript: 'Said in a meeting',
    summary: 'In a summary',
    person: 'People',
    group: 'Folders',
}

const RESULT_ICONS: Record<SearchResultKind, ReactNode> = {
    meeting: <FileTextIcon/>,
    action: <CheckCircleIcon/>,
    transcript: <WaveformIcon/>,
    summary: <NotePencilIcon/>,
    person: <UserIcon/>,
    group: <FolderIcon/>,
}

const THEME_ICONS: Record<ThemeMode, ReactNode> = {light: <SunIcon/>, dark: <MoonIcon/>, system: <MonitorIcon/>}

const Root = styled(Command)`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
`

const Field = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[2.5]};
    height: ${({theme}) => theme.sizes.search.field};
    padding: 0 ${({theme}) => theme.space[3]};
    border-bottom: 1px solid ${({theme}) => theme.colors.border};
    color: ${({theme}) => theme.colors.muted};

    > svg {
        flex: none;
    }
`

const Input = styled(Command.Input)`
    flex: 1;
    min-width: 0;
    height: ${({theme}) => theme.sizes.control.md};
    padding: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: ${({theme}) => theme.colors.text};
    font: inherit;
    ${({theme}) => theme.text.input};

    &::placeholder {
        color: ${({theme}) => theme.colors.muted};
    }
`

const List = styled(Command.List)`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: ${({theme}) => theme.space[1.5]};
    scroll-padding: ${({theme}) => theme.space[1.5]};
`

const Group = styled(Command.Group)`
    padding: ${({theme}) => theme.space[1]} 0;

    [cmdk-group-heading] {
        padding: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[2]} ${({theme}) => theme.space[1]};
        ${({theme}) => theme.text.small};
        font-weight: ${({theme}) => theme.fontWeights.semibold};
        color: ${({theme}) => theme.colors.muted};
    }
`

// The row the keyboard or the pointer is on takes the surface, as the
// design's selected row; cmdk marks it.
const Item = styled(Command.Item)`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2.5]};
    padding: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[2]};
    border-radius: ${({theme}) => theme.radii.md};
    color: ${({theme}) => theme.colors.text};
    cursor: pointer;
    user-select: none;

    &[data-selected='true'] {
        background: ${({theme}) => theme.colors.surface};
    }
`

const Tile = styled.span`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.search.icon};
    height: ${({theme}) => theme.sizes.search.icon};
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme}) => theme.colors.surface};
    color: ${({theme}) => theme.colors.muted};

    [data-selected='true'] > & {
        background: ${({theme}) => theme.colors.raised};
    }

    > svg {
        width: ${({theme}) => theme.sizes.search.glyph};
        height: ${({theme}) => theme.sizes.search.glyph};
    }
`

const Words = styled.span`
    flex: 1;
    min-width: 0;
`

const Title = styled.span`
    display: block;
    overflow: hidden;
    ${({theme}) => theme.text.body};
    white-space: nowrap;
    text-overflow: ellipsis;
`

const Sub = styled.span`
    display: block;
    overflow: hidden;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
    white-space: nowrap;
    text-overflow: ellipsis;
`

const Note = styled.p`
    margin: ${({theme}) => theme.space[4]} ${({theme}) => theme.space[3]};
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.muted};
    text-align: center;
`

const Hints = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[3.5]};
    height: ${({theme}) => theme.sizes.search.hints};
    padding: 0 ${({theme}) => theme.space[3.5]};
    border-top: 1px solid ${({theme}) => theme.colors.border};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const matchesWords = (text: string, query: string) => {
    const haystack = text.toLowerCase()
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => haystack.includes(word))
}

/** Native cuts a long line with "..."; the row quotes it with real ellipses. */
const quoted = (snippet: string) => `“${snippet.replace(/^\.\.\./, '…').replace(/\.\.\.$/, '…')}”`

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const lastSeen = (person: Person) => (person.lastSeenAt ? Date.parse(person.lastSeenAt) || 0 : 0)

/** Contacts by their latest meeting, newest first, then by name; those never named in one last. */
const byLatestMeeting = (a: Person, b: Person) => lastSeen(b) - lastSeen(a) || a.displayName.localeCompare(b.displayName)

/** What a contact row says under the name: their role and company, else their meetings. */
const personSub = (person: Person) => [person.role, person.company].filter(Boolean).join(', ') || plural(person.meetingCount, 'meeting')

const personMatches = (person: Person, query: string) =>
    matchesWords([person.displayName, person.role, person.company, person.email].filter(Boolean).join(' '), query)

interface Row {
    value: string
    icon: ReactNode
    title: string
    /** Read after the title, such as "current" for the theme in use. */
    hidden?: string
    sub?: string
    trailing?: ReactNode
    onSelect: () => void
}

interface RowGroup {
    title: string
    rows: Row[]
}

/**
 * Search and commands (⌘K / Ctrl K): one field for the library, searched
 * natively (`api_global_search`), and for what the app can do. With no
 * query it lists the commands, the recent meetings, a few contacts, Settings
 * and the themes. Contacts have no page of their own (#220, was #209):
 * "Show all people" or Go to › People lists them all in the dialog, the
 * field then filtering them by name, role, company and email, and
 * Backspace in the empty field going back. The groups of results follow
 * native's ranking: a group is listed where its best result ranks. cmdk gives the list its keyboard (arrows,
 * Enter, wrapping); the matching is native's for results and by words for
 * commands. The shell mounts it once with the commands only it can build
 * (`actions`: recording, new folder, new contact).
 */
export function SearchDialog({actions = []}: { actions?: readonly SearchCommand[] }) {
    const navigate = useNavigate()
    const open = useSearchLauncher((state) => state.open)
    const query = useSearchLauncher((state) => state.query)
    // Listing every contact instead of searching; a new opening starts searching again.
    const [allPeople, setAllPeople] = useState(false)
    if (!open && allPeople) setAllPeople(false)
    const input = useRef<HTMLInputElement>(null)
    const listPeople = () => {
        useSearchLauncher.setState({query: ''})
        setAllPeople(true)
    }
    // A row clicked with the pointer took the focus; the filter is typed in the field.
    useEffect(() => {
        if (allPeople) input.current?.focus()
    }, [allPeople])
    const trimmed = query.trim()
    // Below two characters the library is not searched, and old results are not shown.
    const searching = trimmed.length >= MIN_QUERY_LENGTH
    const debounced = useDebounced(trimmed, SEARCH_DEBOUNCE_MS)
    const results = useQuery({...searchQuery(debounced), enabled: open && !allPeople && debounced.length >= MIN_QUERY_LENGTH})
    const meetings = useQuery({...meetingsQuery, enabled: open})
    const folders = useQuery({...foldersQuery, enabled: open})
    const people = useQuery({...peopleQuery, enabled: open})
    const themeMode = useThemeModeStore((state) => state.mode)
    const setThemeMode = useThemeModeStore((state) => state.setMode)

    useHotkey({code: 'KeyK', mod: true}, () => openSearch(), {level: 'app'})

    const go = (path: string) => {
        closeSearch()
        void navigate(path)
    }
    // After the dialog has let go of focus, so a sheet a command opens keeps it.
    const run = (command: SearchCommand) => {
        closeSearch()
        setTimeout(command.run, 0)
    }

    const commands: SearchCommand[] = [
        ...actions,
        {id: 'people', group: 'Go to', label: 'People', keywords: 'contacts persons', icon: <UsersIcon/>, keepOpen: true, run: listPeople},
        {id: 'settings', group: 'Go to', label: 'Settings', keywords: 'preferences options models', icon: <GearIcon/>, shortcut: formatShortcut(','), run: () => go(paths.settings())},
        ...THEME_MODES.map((mode): SearchCommand => ({
            id: `theme-${mode.value}`,
            group: 'Theme',
            keepOpen: true,
            label: mode.label,
            keywords: `theme appearance ${mode.value}`,
            icon: THEME_ICONS[mode.value],
            run: () => setThemeMode(mode.value),
        })),
    ]
    const commandRow = (command: SearchCommand): Row => {
        const current = command.id === `theme-${themeMode}`
        return {
            value: `command:${command.id}`,
            icon: command.icon,
            title: command.label,
            hidden: current ? ', current' : undefined,
            trailing: current ? <CheckIcon aria-hidden/> : command.shortcut && <Kbd>{command.shortcut}</Kbd>,
            onSelect: () => (command.keepOpen ? command.run() : run(command)),
        }
    }
    const shown = trimmed ? commands.filter((command) => matchesWords(`${command.label} ${command.keywords ?? ''}`, trimmed)) : commands
    const byGroup = (group: SearchCommand['group']) => shown.filter((command) => (command.group ?? 'Actions') === group).map(commandRow)

    const folderName = useMemo(() => new Map((folders.data ?? []).map((folder) => [folder.id, folder.name])), [folders.data])
    const meetingFolder = useMemo(() => new Map((meetings.data ?? []).map((meeting) => [meeting.id, meeting.group_id])), [meetings.data])

    const resultRow = (result: SearchResult): Row => {
        const meetingId = result.meetingId ?? result.id
        const when = parseDate(result.timestamp)
        const base = {value: `${result.kind}:${result.id}`, icon: RESULT_ICONS[result.kind]}
        switch (result.kind) {
            case 'person': {
                const company = people.data?.find((person) => person.id === (result.personId ?? result.id))?.company
                return {
                    ...base,
                    title: result.title,
                    sub: [company, plural(result.meetingCount ?? 0, 'meeting')].filter(Boolean).join(' · '),
                    onSelect: () => go(paths.person(result.personId ?? result.id)),
                }
            }
            case 'group':
                return {...base, title: result.title, sub: result.snippet, onSelect: () => go(paths.folder(result.groupId ?? result.id))}
            case 'meeting': {
                const folderId = meetingFolder.get(meetingId)
                const sub = [when && headerWhen(when), folderId && folderName.get(folderId)].filter(Boolean).join(' · ')
                return {...base, title: result.title, sub, onSelect: () => go(paths.meeting(meetingId))}
            }
            case 'action':
                return {
                    ...base,
                    title: result.snippet,
                    sub: `${result.speaker || 'No owner yet'} · ${result.title}`,
                    onSelect: () => go(paths.meeting(meetingId, {tab: 'summary', at: result.audioStartTime})),
                }
            case 'transcript': {
                const sub = [result.speaker, result.audioStartTime != null && formatClock(result.audioStartTime), result.title]
                return {
                    ...base,
                    title: quoted(result.snippet),
                    sub: sub.filter(Boolean).join(' · '),
                    onSelect: () => go(paths.meeting(meetingId, {tab: 'transcript', at: result.audioStartTime, line: result.transcriptId ?? result.id})),
                }
            }
            case 'summary':
                // Native cuts the stored Markdown around the match; the row shows its words.
                return {...base, title: markdownSnippetText(result.snippet), sub: result.title, onSelect: () => go(paths.meeting(meetingId, {tab: 'summary'}))}
        }
    }

    const contacts = useMemo(() => [...(people.data ?? [])].sort(byLatestMeeting), [people.data])
    const contactRow = (person: Person): Row => ({
        value: `contact:${person.id}`,
        icon: <UserIcon/>,
        title: person.displayName,
        sub: personSub(person),
        onSelect: () => go(paths.person(person.id)),
    })

    const groups: RowGroup[] = []
    const add = (title: string, rows: Row[]) => rows.length > 0 && groups.push({title, rows})
    if (allPeople) add('People', contacts.filter((person) => !trimmed || personMatches(person, trimmed)).map(contactRow))
    if (!allPeople) add('Actions', byGroup('Actions'))
    if (!allPeople && !trimmed) {
        add('Recent meetings', (meetings.data ?? []).slice(0, RECENT_MEETINGS).map((meeting) => {
            const when = parseDate(meeting.created_at)
            return {
                value: `recent:${meeting.id}`,
                icon: <FileTextIcon/>,
                title: meeting.title,
                sub: when ? headerWhen(when) : undefined,
                onSelect: () => go(paths.meeting(meeting.id)),
            }
        }))
        const more = contacts.length > PEOPLE_PREVIEW
        add('People', [
            ...contacts.slice(0, PEOPLE_PREVIEW).map(contactRow),
            ...(more ? [{value: 'contacts:all', icon: <UsersIcon/>, title: 'Show all people', sub: plural(contacts.length, 'contact'), onSelect: listPeople}] : []),
        ])
    }
    // Results only for the query they answer: the last ones stay while the
    // next load, but not once the field is too short to search.
    const found = searching && !allPeople ? results.data ?? [] : []
    for (const kind of [...new Set(found.map((result) => result.kind))]) {
        add(GROUP_TITLES[kind], found.filter((result) => result.kind === kind).map(resultRow))
    }
    if (!allPeople) add('Go to', byGroup('Go to'))
    if (!allPeople) add('Theme', byGroup('Theme'))

    const values = groups.flatMap((group) => group.rows.map((row) => row.value))
    const [selected, setSelected] = useState('')
    // A list without the row the user was on starts on its first, as the design lights it.
    const current = values.includes(selected) ? selected : values[0] ?? ''

    const waiting = !allPeople && searching && (trimmed !== debounced || results.isFetching)
    const nothing = groups.length === 0 && !waiting && !(results.isError && !allPeople)
    let nothingText = searching ? `Nothing found for “${trimmed}”.` : 'Type another letter to search your meetings.'
    if (allPeople) nothingText = trimmed ? `No one matches “${trimmed}”.` : people.isPending ? '' : 'No contacts yet. Name a voice in a meeting to add one.'

    return (
        <Sheet open={open} onOpenChange={(next) => !next && closeSearch()} title="Search and commands" bare instant>
            <Root label="Search meetings, people and commands" shouldFilter={false} loop value={current} onValueChange={setSelected}>
                <Field>
                    <MagnifyingGlassIcon aria-hidden/>
                    <Input
                        ref={input}
                        autoFocus
                        placeholder={allPeople ? 'Filter people by name, role, company or email' : 'Search meetings, people, or type a command'}
                        value={query}
                        onValueChange={(value) => useSearchLauncher.setState({query: value})}
                        onKeyDown={(event) => {
                            if (allPeople && event.key === 'Backspace' && query === '') setAllPeople(false)
                        }}
                    />
                    {waiting ? <Spinner delayed/> : <Kbd aria-hidden>esc</Kbd>}
                </Field>
                <List>
                    {results.isError && searching && !allPeople && (
                        <Note role="alert">Search is unavailable: {results.error.message}</Note>
                    )}
                    {nothing && nothingText && <Note>{nothingText}</Note>}
                    {groups.map((group) => (
                        <Group key={group.title} heading={group.title}>
                            {group.rows.map((row) => (
                                <Item key={row.value} value={row.value} onSelect={row.onSelect}>
                                    <Tile aria-hidden>{row.icon}</Tile>
                                    <Words>
                                        <Title>{row.title}{row.hidden && <VisuallyHidden>{row.hidden}</VisuallyHidden>}</Title>
                                        {row.sub && <Sub>{row.sub}</Sub>}
                                    </Words>
                                    {row.trailing}
                                </Item>
                            ))}
                        </Group>
                    ))}
                </List>
                <Hints aria-hidden>
                    <span>↑↓ to move</span>
                    <span>↵ to open</span>
                    {allPeople && <span>⌫ to go back</span>}
                    <span>esc to close</span>
                </Hints>
            </Root>
        </Sheet>
    )
}
