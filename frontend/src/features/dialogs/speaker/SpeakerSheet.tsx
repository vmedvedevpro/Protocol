import {type FormEvent, useMemo, useState} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {meetingKeys, meetingTranscriptsQuery, renameMeetingSpeaker} from '@/api/meetings'
import {isPersonLabel, normalizePersonName, peopleKeys, peopleQuery} from '@/api/people'
import {useUserName} from '@/api/preferences'
import {displaySpeaker, formatClock, isUserSpeaker, lineFromSegment, speakerParts} from '@/components/transcript/turns'
import {Button} from '@/components/ui/Button'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {TextField} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'
import {closeDialog, type OpenedDialog, useDialog} from '@/lib/dialogs'
import {reassignTranscriptSpeaker} from '../api/speakers'
import {type Choice, Choices} from '../components/Choices'

const FORM_ID = 'who-said-this'

// How many contacts the search shows; typing narrows them.
const SHOWN_CONTACTS = 6

type Scope = 'all' | 'line'

const Form = styled.form`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3]};
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
    const {open, request} = useDialog('speaker')
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

function SpeakerForm({request, onSaving}: { request: OpenedDialog<'speaker'>, onSaving: (saving: boolean) => void }) {
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
    const named: Choice<string>[] = [
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

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        if (!to || to === from) return void toast.info('Pick who said it')
        onSaving(true)
        try {
            if (live) {
                await live.rename(from, to)
                toast.success(`${shown(from)} is now ${shown(to)}`)
            } else if (meetingId && scope === 'all') {
                const result = await renameMeetingSpeaker(meetingId, from, to)
                toast.success(`${shown(from)} is now ${shown(result.speaker)}`, {
                    description: `${result.count} ${result.count === 1 ? 'line' : 'lines'} updated.`,
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
                <Choices<string>
                    legend="Which voice"
                    layout="grid"
                    choices={parts.map((part) => ({value: part, label: shown(part)}))}
                    value={from}
                    onChange={setFrom}
                />
            )}
            <TextField
                type="search"
                aria-label="Search contacts or type a name"
                placeholder={live ? 'Type a name' : 'Search contacts or type a name'}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
            />
            <Choices<string> legend="People" choices={named} value={chosen} onChange={setPick}/>
            {scope === 'all' && voices.length > 0 && (
                <Choices<string>
                    legend="Merge with another voice"
                    layout="grid"
                    choices={voices.map((voice) => ({value: `voice:${voice}`, label: voice}))}
                    value={chosen}
                    onChange={setPick}
                />
            )}
            {!live && (
                <Choices<Scope>
                    legend="Change"
                    choices={[
                        {value: 'all', label: `Every line from ${shown(from)}`},
                        {
                            value: 'line',
                            label: request.lineIds.length === 1 ? 'Just this line' : `Just these ${request.lineIds.length} lines`,
                            description: parts.length > 1 ? 'The other speakers on this line are kept' : undefined,
                        },
                    ]}
                    value={scope}
                    onChange={setScope}
                />
            )}
        </Form>
    )
}
