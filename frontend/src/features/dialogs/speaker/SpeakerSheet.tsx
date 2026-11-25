import {type FormEvent, useMemo, useState} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {meetingKeys, meetingTranscriptsQuery, renameMeetingSpeaker} from '@/api/meetings'
import {
    isPersonLabel,
    normalizePersonName,
    type Person,
    peopleKeys,
    peopleQuery,
    personForSpeaker,
    personProfileQuery,
    voiceProfilesQuery,
} from '@/api/people'
import {useUserName} from '@/api/preferences'
import {displaySpeaker, formatClock, isUserSpeaker, lineFromSegment, speakerParts} from '@/components/transcript/turns'
import {Button} from '@/components/ui/Button'
import {SettingsRadioGroup, SettingsRadioRow} from '@/components/ui/SettingsRow'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {TextField} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'
import {closeDialog, type OpenedDialog, useDialog} from '@/lib/dialogs'
import {reassignTranscriptSpeaker} from '../api/speakers'

const FORM_ID = 'who-said-this'

// How many contacts the search shows; typing narrows them.
const SHOWN_CONTACTS = 6

type Scope = 'all' | 'line'

const Form = styled.form`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3]};
`

// What a save does to a contact it empties; merges have no Undo.
const Caution = styled.p`
    margin: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.text};
`

const Quote = styled.blockquote`
    margin: 0;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.surface};
    ${({theme}) => theme.text.body};

    > span {
        display: block;
        ${({theme}) => theme.text.small};
        color: ${({theme}) => theme.colors.muted};
    }

    > p {
        display: -webkit-box;
        margin: 0;
        overflow: hidden;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
    }
`

/**
 * Who said this line, from a turn's speaker menu: the voice becomes a
 * contact, a new name (native makes it a contact), the user, or another
 * voice of the meeting (a merge), on every line of that voice or only on
 * this turn's lines, where the other voices of an overlap stay. A recording
 * in progress renames the voice in its session; one line alone and the
 * contact link wait for the saved meeting there.
 */
export function SpeakerSheet() {
    const slot = useDialog()
    const request = slot.request?.kind === 'speaker' ? slot.request : null
    const open = slot.open && request !== null
    const [saving, setSaving] = useState(false)
    return (
        <Sheet
            open={open}
            onOpenChange={(next) => !next && !saving && closeDialog('speaker')}
            title="Who said this line?"
            description="Pick a contact, type a new name, or merge with another voice."
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button variant="filled" type="submit" form={FORM_ID} pending={saving}>Save</Button>
                </>
            )}
        >
            {request && <SpeakerForm key={request.seq} request={request} onSaving={setSaving}/>}
        </Sheet>
    )
}

function SpeakerForm({request, onSaving}: { request: Extract<OpenedDialog, { kind: 'speaker' }>, onSaving: (saving: boolean) => void }) {
    const {meetingId, live} = request
    const client = useQueryClient()
    const userName = useUserName() || undefined
    const transcript = useQuery({...meetingTranscriptsQuery(meetingId ?? ''), enabled: !!meetingId})
    // A recording's new names become contacts when it is saved, not here.
    const people = useQuery({...peopleQuery, enabled: !live})
    const lines = useMemo(() => live?.lines ?? (transcript.data ?? []).map(lineFromSegment), [live, transcript.data])

    const parts = speakerParts(request.speaker)
    const [from, setFrom] = useState(parts[0] ?? request.speaker)
    const [query, setQuery] = useState('')
    const [pick, setPick] = useState('')
    const [scope, setScope] = useState<Scope>('all')
    const shown = (label: string) => displaySpeaker(label, userName)

    const said = lines.filter((line) => request.lineIds.includes(line.id))
    const start = said[0]?.start ?? null
    const voices = [...new Set(lines.flatMap((line) => speakerParts(line.speaker ?? '')))]
        .filter((voice) => voice !== from && !isUserSpeaker(voice) && !parts.includes(voice))

    const typed = query.trim()
    const contacts = (people.data ?? [])
        .filter((person) => !typed || normalizePersonName(person.displayName).includes(normalizePersonName(typed)))
        .slice(0, SHOWN_CONTACTS)
    const exact = (people.data ?? []).some((person) => normalizePersonName(person.displayName) === normalizePersonName(typed)) ||
        voices.some((voice) => normalizePersonName(voice) === normalizePersonName(typed))
    const named: { value: string, label: string, description?: string }[] = [
        ...contacts.map((person) => ({
            value: `name:${person.displayName}`,
            label: person.displayName,
            description: person.company || person.groups[0]?.name,
        })),
        ...(typed && !exact && isPersonLabel(typed) ? [{value: `name:${typed}`, label: `New contact “${typed}”`}] : []),
        ...(!isUserSpeaker(from) ? [{value: 'name:You', label: 'This is me', description: userName}] : []),
    ]
    // A pick the search no longer shows is not a pick.
    const chosen = named.some((choice) => choice.value === pick) || (scope === 'all' && voices.some((voice) => pick === `voice:${voice}`)) ? pick : ''
    const to = chosen.replace(/^(name|voice):/, '')
    const emptied = useEmptiedContact(!live && !!meetingId && scope === 'all' && !!to ? people.data : undefined, from, to)
    const caution = emptied && removalNote(emptied, people.data ?? [], to, shown(to))

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        if (!to || to === from) return void toast.info('Pick who said it')
        // The warning is not shown yet; a save now could delete what it names.
        if (emptied?.loading) return
        onSaving(true)
        try {
            if (live) {
                await live.rename(from, to)
                toast.success(`${shown(from)} is now ${shown(to)}`)
            } else if (meetingId && scope === 'all') {
                const result = await renameMeetingSpeaker(meetingId, from, to, {removeEmptiedContact: !!emptied})
                const lines = `${result.count} ${result.count === 1 ? 'line' : 'lines'} updated.`
                toast.success(`${shown(from)} is now ${shown(result.speaker)}`, {
                    description: result.removedContact ? `${lines} The contact ${emptied?.person.displayName} was removed.` : lines,
                })
            } else if (meetingId) {
                for (const lineId of request.lineIds) await reassignTranscriptSpeaker(meetingId, lineId, to, from)
                toast.success(`${request.lineIds.length === 1 ? 'This line is' : 'These lines are'} now ${shown(to)}’s`)
            }
            if (meetingId) {
                await Promise.all([
                    client.invalidateQueries({queryKey: meetingKeys.transcripts(meetingId)}),
                    client.invalidateQueries({queryKey: peopleKeys.all}),
                ])
            }
            closeDialog('speaker')
        } catch (error) {
            toast.error('Couldn’t change the speaker', {description: errorMessage(error)})
        } finally {
            onSaving(false)
        }
    }

    return (
        <Form id={FORM_ID} onSubmit={(event) => void submit(event)}>
            {said.length > 0 && (
                <Quote>
                    <span>{shown(request.speaker)}{start === null ? '' : ` · ${formatClock(start)}`}</span>
                    <p>{said.map((line) => line.text).join(' ')}</p>
                </Quote>
            )}
            {parts.length > 1 && (
                <SettingsRadioGroup title="Which voice" layout="grid" value={from} onValueChange={setFrom}>
                    {parts.map((part) => <SettingsRadioRow key={part} value={part} label={shown(part)}/>)}
                </SettingsRadioGroup>
            )}
            <TextField
                type="search"
                aria-label="Search contacts or type a name"
                placeholder={live ? 'Type a name' : 'Search contacts or type a name'}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
            />
            <SettingsRadioGroup title="People" value={chosen} onValueChange={setPick}>
                {named.map((option) => <SettingsRadioRow key={option.value} {...option}/>)}
            </SettingsRadioGroup>
            {scope === 'all' && voices.length > 0 && (
                <SettingsRadioGroup title="Merge with another voice" layout="grid" value={chosen} onValueChange={setPick}>
                    {voices.map((voice) => <SettingsRadioRow key={voice} value={`voice:${voice}`} label={voice}/>)}
                </SettingsRadioGroup>
            )}
            {!live && (
                <SettingsRadioGroup<Scope> title="Change" value={scope} onValueChange={setScope}>
                    <SettingsRadioRow value="all" label={`Every line from ${shown(from)}`}/>
                    <SettingsRadioRow
                        value="line"
                        label={request.lineIds.length === 1 ? 'Just this line' : `Just these ${request.lineIds.length} lines`}
                        description={parts.length > 1 ? 'The other speakers on this line are kept' : undefined}
                    />
                </SettingsRadioGroup>
            )}
            {caution && <Caution role="status">{caution}</Caution>}
        </Form>
    )
}

interface EmptiedContact {
    person: Person
    notes: boolean
    voice: boolean
    /** Its notes and voice are still being read: Save waits, so the warning names them first. */
    loading: boolean
    /** They could not be read, so the warning cannot name them. */
    unknown: boolean
}

/**
 * The contact `from` belongs to when moving every line of it would leave it
 * in no meeting, with what it keeps besides its lines; native checks the
 * same again when it saves (PeopleRepository::rename_speaker). `people` is
 * undefined while the change is not one of every line of a saved meeting.
 */
function useEmptiedContact(people: readonly Person[] | undefined, from: string, to: string): EmptiedContact | null {
    const source = people && personForSpeaker(people, from)
    const emptied = source && source.meetingCount <= 1 && normalizePersonName(to) !== normalizePersonName(source.displayName) ? source : undefined
    const profile = useQuery({...personProfileQuery(emptied?.id ?? ''), enabled: !!emptied})
    const voices = useQuery({...voiceProfilesQuery, enabled: !!emptied})
    if (!emptied) return null
    return {
        person: emptied,
        notes: !!profile.data?.notes,
        voice: !!voices.data?.some((voice) => voice.person_id === emptied.id),
        loading: profile.isPending || voices.isPending,
        unknown: profile.isError || voices.isError,
    }
}

/**
 * "Tom isn’t in any other meeting, so the contact is merged into Thomas…",
 * or what is deleted with it; nothing while its notes and voice load.
 * A merge appends the notes and fills only the details the kept contact
 * lacks (PeopleRepository::merge_in).
 */
function removalNote({person, notes, voice, loading, unknown}: EmptiedContact, people: readonly Person[], to: string, toName: string): string | null {
    if (loading) return null
    const lead = `${person.displayName} isn’t in any other meeting, so the contact`
    // A contact name merges (a new name becomes a contact first); You and a voice are no contact.
    if (isPersonLabel(to)) {
        const into = personForSpeaker(people, to) ? toName : `the new contact ${toName}`
        return `${lead} is merged into ${into}. Its notes are added to ${toName}’s, its details fill in only what ${toName} has none of, and its voice moves there.`
    }
    const details = !!(person.email || person.company || person.role || person.phone)
    const lost = [notes && 'private notes', details && 'details', voice && 'voice profile'].filter(Boolean) as string[]
    if (unknown) return `${lead} is deleted, with everything it keeps.`
    const what = lost.length ? `, with its ${lost.length > 1 ? `${lost.slice(0, -1).join(', ')} and ${lost[lost.length - 1]}` : lost[0]}` : ''
    return `${lead} is deleted${what}.`
}
