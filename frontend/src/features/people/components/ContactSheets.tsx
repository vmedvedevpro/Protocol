import {type FormEvent, useState} from 'react'
import {useMutation, useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {
    createPersonMutation,
    deletePersonMutation,
    mergePeopleMutation,
    type Person,
    type PersonDetails,
    peopleQuery,
    updatePersonMutation,
} from '@/api/people'
import {Button} from '@/components/ui/Button'
import {Select} from '@/components/ui/Select'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {TextField} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'

const Fields = styled.form`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3]};
`

const Problem = styled.p`
    margin: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.text};
`

const Text = styled.p`
    margin: 0 0 ${({theme}) => theme.space[3]};
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.soft};
`

/** The contact a sheet edits: what Person and PersonProfile share. */
export type ContactFields = Pick<Person, 'id' | 'displayName' | 'email' | 'company' | 'role' | 'phone'>

const CONTACT_FORM = 'contact-details'

/**
 * Adds a contact, or edits `contact`'s details. Native refuses a blank name
 * and one another contact has; the sheet stays open and says so.
 */
export function ContactSheet({open, onOpenChange, contact, onSaved}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** The contact to edit; none adds one. */
    contact?: ContactFields | null
    onSaved?: (person: Person) => void
}) {
    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={contact ? 'Edit contact' : 'New contact'}
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button variant="filled" type="submit" form={CONTACT_FORM}>{contact ? 'Save' : 'Add contact'}</Button>
                </>
            )}
        >
            <ContactForm contact={contact ?? null} onDone={() => onOpenChange(false)} onSaved={onSaved}/>
        </Sheet>
    )
}

// Its own component, so each opening starts from the contact's details.
function ContactForm({contact, onDone, onSaved}: {
    contact: ContactFields | null
    onDone: () => void
    onSaved?: (person: Person) => void
}) {
    const [details, setDetails] = useState<Required<PersonDetails>>({
        displayName: contact?.displayName ?? '',
        email: contact?.email ?? '',
        company: contact?.company ?? '',
        role: contact?.role ?? '',
        phone: contact?.phone ?? '',
    })
    const create = useMutation(createPersonMutation)
    const update = useMutation(updatePersonMutation(contact?.id ?? ''))
    const save = contact ? update : create
    const pending = create.isPending || update.isPending

    const submit = (event: FormEvent) => {
        event.preventDefault()
        if (pending) return
        save.mutate(details, {
            onSuccess: (person) => {
                onDone()
                onSaved?.(person)
            },
        })
    }

    const field = (key: keyof PersonDetails, label: string, extra: { placeholder?: string, type?: string, autoFocus?: boolean } = {}) => (
        <TextField
            label={label}
            value={details[key] ?? ''}
            aria-invalid={key === 'displayName' && !!save.error}
            onChange={(event) => {
                setDetails((current) => ({...current, [key]: event.target.value}))
                save.reset()
            }}
            {...extra}
        />
    )

    return (
        <Fields id={CONTACT_FORM} onSubmit={submit}>
            {field('displayName', 'Name', {autoFocus: true, placeholder: 'Priya Shah'})}
            {save.error && <Problem role="alert">{save.error.message}</Problem>}
            {field('email', 'Email', {type: 'email', placeholder: 'priya@example.com'})}
            {field('company', 'Company')}
            {field('role', 'Role')}
            {field('phone', 'Phone', {type: 'tel'})}
        </Fields>
    )
}

/**
 * Folds this contact into another the user picks: their meetings, action
 * items, notes and voice move there, and this one is removed.
 */
export function MergeContactSheet({open, onOpenChange, contact, onMerged}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    contact: ContactFields | null
    onMerged: (kept: Person) => void
}) {
    const people = useQuery({...peopleQuery, enabled: open})
    const merge = useMutation(mergePeopleMutation)
    const [targetId, setTargetId] = useState<string | undefined>(undefined)
    const others = (people.data ?? []).filter((person) => person.id !== contact?.id)
    const target = others.find((person) => person.id === targetId)
    const name = contact?.displayName ?? ''

    return (
        <Sheet
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next)
                if (!next) setTargetId(undefined)
            }}
            title={`Merge ${name}`}
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button
                        variant="filled"
                        disabled={!target}
                        pending={merge.isPending}
                        onClick={() => contact && target && merge.mutate({sourceId: contact.id, targetId: target.id}, {
                            onSuccess: (kept) => {
                                onOpenChange(false)
                                toast.success(`Merged into ${kept.displayName}`)
                                onMerged(kept)
                            },
                            onError: (error) => toast.error('Couldn’t merge the contacts', {description: error.message}),
                        })}
                    >
                        Merge
                    </Button>
                </>
            )}
        >
            <Text>
                {name}’s meetings, action items, notes and voice move to the contact you pick, and {name} is removed.
            </Text>
            <Select
                label="Merge into"
                placeholder={people.isPending ? 'Loading contacts…' : 'Choose a contact'}
                pending={people.isPending}
                disabled={others.length === 0}
                options={others.map((person) => ({value: person.id, label: person.displayName}))}
                value={targetId}
                onValueChange={setTargetId}
            />
        </Sheet>
    )
}

/** Deletes a contact after asking; their meetings stay. */
export function DeleteContactSheet({open, onOpenChange, contact, onDeleted}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    contact: ContactFields | null
    onDeleted: () => void
}) {
    const remove = useMutation(deletePersonMutation)
    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={`Delete ${contact?.displayName ?? 'this contact'}?`}
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button
                        variant="filled"
                        pending={remove.isPending}
                        onClick={() => contact && remove.mutate(contact.id, {
                            onSuccess: () => {
                                onOpenChange(false)
                                toast.success('Contact deleted')
                                onDeleted()
                            },
                            onError: (error) => toast.error('Couldn’t delete the contact', {description: error.message}),
                        })}
                    >
                        Delete contact
                    </Button>
                </>
            )}
        >
            <Text>
                Their lines in meetings go back to “Speaker” labels, their action items keep the owner’s name without the
                link, and their voice is forgotten. Meetings stay.
            </Text>
        </Sheet>
    )
}
