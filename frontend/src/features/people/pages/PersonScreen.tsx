import {type ReactNode, type RefObject, useEffect, useRef, useState} from 'react'
import {DotsThreeIcon, GitMergeIcon, PencilSimpleIcon, TrashIcon} from '@phosphor-icons/react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import {Link, useNavigate, useParams} from 'react-router-dom'
import styled, {css} from 'styled-components'
import {type ActionItem, actionItemsQuery, updateActionItemMutation} from '@/api/actionItems'
import {errorMessage} from '@/api/core'
import {
    describeVoiceSource,
    forgetVoiceMutation,
    learnPersonVoiceMutation,
    peopleKeys,
    type PersonProfile,
    personProfileQuery,
    updatePersonNotesMutation,
    voiceProfilesQuery,
} from '@/api/people'
import {nativeLabQuery} from '@/api/labs'
import {Screen} from '@/components/screen/Screen'
import {Button, IconButton} from '@/components/ui/Button'
import {Menu, MenuItem, MenuSeparator} from '@/components/ui/Menu'
import {Spinner} from '@/components/ui/Spinner'
import {colorTransition, focusRing} from '@/components/ui/styles'
import {TextArea} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'
import {useAutosave, useSaving} from '@/lib/autosave'
import {dayWhen, parseDate} from '@/lib/dates'
import {paths} from '@/lib/paths'
import {tween} from '@/styles/motion'
import {ContactSheet, DeleteContactSheet, MergeContactSheet} from '../components/ContactSheets'

const Head = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
    padding: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3.5]} ${({theme}) => theme.space[5]};
`

const Who = styled.div`
    flex: 1;
    min-width: 0;
`

const Name = styled.h1`
    margin: 0;
    overflow: hidden;
    ${({theme}) => theme.text.title};
    font-size: ${({theme}) => theme.text.screen.fontSize};
    white-space: nowrap;
    text-overflow: ellipsis;
`

const Muted = styled.p`
    margin: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Body = styled.div`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 ${({theme}) => theme.space[4]} ${({theme}) => theme.space[4]};
    border-top: 1px solid ${({theme}) => theme.colors.border};
`

const Section = styled.section`
    margin-top: ${({theme}) => theme.space[3.5]};
`

const SectionHead = styled.div`
    display: flex;
    align-items: baseline;
    gap: ${({theme}) => theme.space[1.5]};
    padding: 0 ${({theme}) => theme.space[1]} ${({theme}) => theme.space[1.5]};
`

const SectionTitle = styled.h2`
    flex: 1;
    margin: 0;
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
    color: ${({theme}) => theme.colors.muted};
`

const TextButton = styled.button`
    padding: 0 ${({theme}) => theme.space[0.5]};
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: none;
    color: ${({theme}) => theme.colors.muted};
    font: inherit;
    ${({theme}) => theme.text.small};
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    &:hover {
        color: ${({theme}) => theme.colors.text};
    }
`

const Badge = styled.span`
    padding: 0 ${({theme}) => theme.space[1]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.xs};
    ${({theme}) => theme.text.caption};
    color: ${({theme}) => theme.colors.muted};
`

const Card = styled.div`
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.surface};
`

const rowStyle = css`
    display: flex;
    gap: ${({theme}) => theme.space[3]};
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[3]};
    ${({theme}) => theme.text.body};

    & + & {
        border-top: 1px solid ${({theme}) => theme.colors.border};
    }
`

const DetailRow = styled.div`
    ${rowStyle};
`

const DetailLabel = styled.span`
    flex: none;
    width: ${({theme}) => theme.sizes.detailLabel};
    color: ${({theme}) => theme.colors.muted};
`

const DetailValue = styled.span<{ $missing: boolean }>`
    min-width: 0;
    overflow-wrap: anywhere;
    color: ${({theme, $missing}) => ($missing ? theme.colors.muted : theme.colors.text)};
`

const RowLink = styled(Link)`
    ${rowStyle};
    align-items: center;
    color: ${({theme}) => theme.colors.text};
    text-decoration: none;
    border-radius: ${({theme}) => theme.radii.md};
    ${colorTransition};
    ${focusRing};

    &:hover {
        background: ${({theme}) => theme.colors.raised};
    }
`

const Grow = styled.span`
    flex: 1;
    min-width: 0;
`

const OneLine = styled.span`
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
`

const Sub = styled.span`
    display: block;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const When = styled.span`
    flex: none;
    ${({theme}) => theme.text.small};
    font-variant-numeric: tabular-nums;
    color: ${({theme}) => theme.colors.muted};
`

const ItemRow = styled(m.div)`
    ${rowStyle};
    align-items: flex-start;
    gap: ${({theme}) => theme.space[2.5]};
`

const Check = styled.input`
    flex: none;
    margin: ${({theme}) => theme.space[0.5]} 0 0;
    accent-color: ${({theme}) => theme.colors.text};
    cursor: pointer;
    ${focusRing};
`

const ItemLink = styled(Link)`
    flex: 1;
    min-width: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    color: ${({theme}) => theme.colors.text};
    text-decoration: none;
    ${focusRing};

    &:hover > span:first-child {
        text-decoration: underline;
    }
`

const VoiceRow = styled.div`
    ${rowStyle};
    align-items: center;
`

const Empty = styled.p`
    margin: 0;
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.muted};
`

const Footnote = styled(Muted)`
    padding: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[1]} 0;
`

const Centered = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[6]} ${({theme}) => theme.space[9]};
    text-align: center;
`

const Heading = styled.p`
    margin: 0;
    ${({theme}) => theme.text.heading};
`

/** `/person/:personId`: the route reads the id; the screen renders once per contact. */
export function PersonRoute() {
    const {personId = ''} = useParams()
    return <PersonScreen key={personId} personId={personId}/>
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name

/**
 * A contact (#118): their details, their voice (Labs), the action items
 * they still owe, the meetings they spoke in and the user's private notes.
 * It opens from search and from a name in a meeting's transcript; Edit,
 * Merge and Delete are in its menu.
 */
export function PersonScreen({personId}: { personId: string }) {
    const navigate = useNavigate()
    const profile = useQuery(personProfileQuery(personId))
    const [sheet, setSheet] = useState<'edit' | 'merge' | 'delete' | null>(null)
    // Notes typed just before a merge or delete go out first: a merge moves
    // them to the contact kept, and once the contact is gone a save has
    // nowhere to land.
    const flushNotes = useRef<(() => void) | null>(null)
    const endContact = (name: 'merge' | 'delete') => {
        flushNotes.current?.()
        setSheet(name)
    }
    const sheetOpen = (name: typeof sheet) => ({
        open: sheet === name,
        onOpenChange: (open: boolean) => setSheet(open ? name : null),
    })

    if (profile.isError) {
        return (
            <Screen>
                <Centered role="alert">
                    <Heading>This contact isn’t available</Heading>
                    <Muted>{errorMessage(profile.error)}</Muted>
                    <Button size="sm" onClick={() => void navigate(paths.home)}>Back to meetings</Button>
                </Centered>
            </Screen>
        )
    }
    if (profile.isPending) return <Screen><Centered aria-busy="true"><Spinner delayed/></Centered></Screen>

    const person = profile.data
    const subtitle = [person.role, person.company].filter(Boolean).join(' · ')

    return (
        <Screen>
            <Head>
                <Who>
                    <Name>{person.displayName}</Name>
                    {subtitle && <Muted>{subtitle}</Muted>}
                </Who>
                <Menu
                    trigger={(
                        <IconButton label="More: edit, merge, delete">
                            <DotsThreeIcon size={17} weight="bold" aria-hidden/>
                        </IconButton>
                    )}
                >
                    <MenuItem icon={<PencilSimpleIcon/>} onSelect={() => setSheet('edit')}>Edit details</MenuItem>
                    <MenuItem icon={<GitMergeIcon/>} onSelect={() => endContact('merge')}>Merge with another contact…</MenuItem>
                    <MenuSeparator/>
                    <MenuItem icon={<TrashIcon/>} onSelect={() => endContact('delete')}>Delete contact…</MenuItem>
                </Menu>
            </Head>
            <Body>
                <Details person={person} onEdit={() => setSheet('edit')}/>
                <Voice person={person}/>
                <OpenItems person={person}/>
                <Meetings person={person}/>
                <Notes person={person} flushRef={flushNotes}/>
            </Body>
            <ContactSheet {...sheetOpen('edit')} contact={person}/>
            <MergeContactSheet
                {...sheetOpen('merge')}
                contact={person}
                onMerged={(kept) => void navigate(paths.person(kept.id), {replace: true})}
            />
            <DeleteContactSheet {...sheetOpen('delete')} contact={person} onDeleted={() => void navigate(paths.home, {replace: true})}/>
        </Screen>
    )
}

function SectionHeader({id, title, children}: { id: string, title: string, children?: ReactNode }) {
    return (
        <SectionHead>
            <SectionTitle id={id}>{title}</SectionTitle>
            {children}
        </SectionHead>
    )
}

function Details({person, onEdit}: { person: PersonProfile, onEdit: () => void }) {
    const rows: [string, string | undefined][] = [
        ['Email', person.email],
        ['Company', person.company],
        ['Role', person.role],
        ['Phone', person.phone],
    ]
    return (
        <Section aria-labelledby="person-details">
            <SectionHeader id="person-details" title="Details">
                <TextButton type="button" onClick={onEdit}>Edit</TextButton>
            </SectionHeader>
            <Card>
                {rows.map(([label, value]) => (
                    <DetailRow key={label}>
                        <DetailLabel>{label}</DetailLabel>
                        <DetailValue $missing={!value}>{value || 'Not added'}</DetailValue>
                    </DetailRow>
                ))}
            </Card>
        </Section>
    )
}

/**
 * Labs › Voice profiles: shown while the switch is on, or when a voice was
 * learned before it was turned off (then it can only be forgotten).
 */
function Voice({person}: { person: PersonProfile }) {
    const enabled = useQuery(nativeLabQuery('voiceProfiles'))
    const voices = useQuery(voiceProfilesQuery)
    const learn = useMutation(learnPersonVoiceMutation)
    const forget = useMutation(forgetVoiceMutation)
    const voice = voices.data?.find((entry) => entry.person_id === person.id)
    const first = firstName(person.displayName)
    const on = enabled.data === true

    if (!on && !voice) return null

    const learnVoice = () => learn.mutate(person.id, {
        onSuccess: (learned) => toast.success(`${voice ? 'Updated' : 'Learned'} ${first}’s voice`, {description: `From ${describeVoiceSource(learned)}.`}),
        onError: (error) => toast.error(`Couldn’t ${voice ? 'update' : 'learn'} ${first}’s voice`, {description: error.message}),
    })
    const forgetVoice = () => forget.mutate(person.id, {
        onSuccess: () => toast.success(`Forgot ${first}’s voice`),
        onError: (error) => toast.error('Couldn’t forget the voice', {description: error.message}),
    })

    let line: string
    let detail: string
    if (voice) {
        line = `Learned from ${voice.meetings} meeting${voice.meetings === 1 ? '' : 's'}`
        detail = on ? 'Later meetings name this voice automatically' : 'Voice profiles are off in Settings › Labs, so it isn’t used'
    } else {
        line = 'Not learned yet'
        detail = person.meetingCount > 0
            ? `From their meetings where ${first} spoke on the call`
            : `Once ${first} is named in a recorded meeting`
    }

    return (
        <Section aria-labelledby="person-voice">
            <SectionHeader id="person-voice" title="Voice"><Badge>Labs</Badge></SectionHeader>
            <Card>
                <VoiceRow>
                    <Grow>
                        <OneLine>{line}</OneLine>
                        <Sub>{detail}</Sub>
                    </Grow>
                    {on && (
                        <Button size="sm" pending={learn.isPending} disabled={forget.isPending || person.meetingCount === 0} onClick={learnVoice}>
                            {voice ? 'Update' : 'Learn'}
                        </Button>
                    )}
                    {voice && (
                        <Button size="sm" pending={forget.isPending} disabled={learn.isPending} onClick={forgetVoice}>Forget</Button>
                    )}
                </VoiceRow>
            </Card>
        </Section>
    )
}

/** What they still owe: checking one off moves it out, with Undo in the toast. */
function OpenItems({person}: { person: PersonProfile }) {
    const items = useQuery(actionItemsQuery({personId: person.id, openOnly: true}))
    const update = useMutation(updateActionItemMutation)
    const first = firstName(person.displayName)

    const setDone = (item: ActionItem, done: boolean) => update.mutate({...item, done}, {
        onSuccess: () => done && toast.success('Marked as done', {
            description: item.text,
            action: {label: 'Undo', onClick: () => setDone(item, false)},
        }),
        onError: (error) => toast.error('Couldn’t update the action item', {description: error.message}),
    })

    return (
        <Section aria-labelledby="person-items">
            <SectionHeader id="person-items" title="Open action items"/>
            <Card>
                {items.isError && <Empty role="alert">Couldn’t load the action items: {items.error.message}</Empty>}
                {items.isSuccess && items.data.length === 0 && <Empty>Nothing open for {first}.</Empty>}
                <AnimatePresence initial={false}>
                    {(items.data ?? []).map((item) => (
                        <ItemRow
                            key={item.id}
                            initial={{opacity: 0, y: 4}}
                            animate={{opacity: 1, y: 0}}
                            exit={{opacity: 0, transition: tween('base', 'exit')}}
                            transition={tween('base', 'enter')}
                        >
                            <Check
                                type="checkbox"
                                checked={item.done}
                                aria-label={`Mark “${item.text}” as done`}
                                onChange={(event) => setDone(item, event.target.checked)}
                            />
                            <ItemLink to={paths.meeting(item.meetingId, {tab: 'summary', at: item.audioTime})}>
                                <OneLine>{item.text}</OneLine>
                                <Sub>{[item.dueText, item.meetingTitle].filter(Boolean).join(' · ')}</Sub>
                            </ItemLink>
                        </ItemRow>
                    ))}
                </AnimatePresence>
            </Card>
        </Section>
    )
}

/** The meetings they spoke in, newest first; the old library's `?person=` filter. */
function Meetings({person}: { person: PersonProfile }) {
    return (
        <Section aria-labelledby="person-meetings">
            <SectionHeader id="person-meetings" title="Meetings together"/>
            <Card>
                {person.meetings.length === 0 && <Empty>{firstName(person.displayName)} isn’t named in a meeting yet.</Empty>}
                {person.meetings.map((meeting) => {
                    const date = parseDate(meeting.createdAt)
                    return (
                        <RowLink key={meeting.meetingId} to={paths.meeting(meeting.meetingId)}>
                            <Grow><OneLine>{meeting.title}</OneLine></Grow>
                            {date && <When>{dayWhen(date)}</When>}
                        </RowLink>
                    )
                })}
            </Card>
        </Section>
    )
}

/**
 * Private notes, saved as the user types and never sent to AI. The field
 * keeps its own text: a save writes into the cached profile, never back
 * into the field. So the field starts only once no save of these notes is
 * on its way (`useSaving`, the #130 review): a save flushed as the screen
 * closed lands after the screen opens again, and the cached text is older.
 */
function Notes({person, flushRef}: { person: PersonProfile, flushRef: RefObject<(() => void) | null> }) {
    const saving = useSaving(`person-notes:${person.id}`)
    const [ready, setReady] = useState(false)
    if (!saving && !ready) setReady(true)
    return (
        <Section aria-labelledby="person-notes">
            <SectionHeader id="person-notes" title="Private notes"/>
            {ready ? <NotesField person={person} flushRef={flushRef}/> : <Spinner delayed/>}
            <Footnote>Only for you. Saved as you type, and never sent to AI.</Footnote>
        </Section>
    )
}

function NotesField({person, flushRef}: { person: PersonProfile, flushRef: RefObject<(() => void) | null> }) {
    const client = useQueryClient()
    // A save still running when the screen closes keeps its toast: the error
    // is the mutation's, not this field's.
    const save = useMutation({
        ...updatePersonNotesMutation(person.id),
        onError: (error) => toast.error('Couldn’t save the notes', {description: error.message}),
    })
    const [text, setText] = useState(person.notes ?? '')
    // As a meeting's notes: saved when typing pauses, and at once when the
    // screen closes. A merge or delete removes the profile from the cache
    // before the screen closes: the contact is gone, so there is nothing to
    // save to (what was typed went out as the sheet opened).
    const autosave = useAutosave((value: string) => {
        if (client.getQueryData(peopleKeys.profile(person.id))) save.mutate(value)
    })
    useEffect(() => {
        flushRef.current = autosave.flush
        return () => {
            flushRef.current = null
        }
    }, [autosave, flushRef])

    return (
        <TextArea
            aria-labelledby="person-notes"
            tone="soft"
            rows={3}
            placeholder="Context, preferences, follow-ups…"
            value={text}
            onChange={(event) => {
                setText(event.target.value)
                autosave.schedule(event.target.value)
            }}
        />
    )
}
