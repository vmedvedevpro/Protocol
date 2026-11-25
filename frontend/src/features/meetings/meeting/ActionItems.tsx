import {type FormEvent, useState} from 'react'
import {PlayIcon, PlusIcon} from '@phosphor-icons/react'
import {useMutation, useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {
    type ActionItem,
    actionItemsQuery,
    createActionItemMutation,
    deleteActionItemMutation,
    updateActionItemMutation,
} from '@/api/actionItems'
import {formatClock} from '@/components/transcript/turns'
import {Button, IconButton} from '@/components/ui/Button'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {colorTransition, focusRing} from '@/components/ui/styles'
import {TextField} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'

const Section = styled.section`
    margin-top: ${({theme}) => theme.space[5]};
`

const SummaryHeading = styled.h2`
    margin: 0 0 ${({theme}) => theme.space[1.5]};
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
    color: ${({theme}) => theme.colors.muted};
`

const List = styled.ul`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[1]};
    margin: 0 0 ${({theme}) => theme.space[1.5]};
    padding: 0;
    list-style: none;
`

const Row = styled.li`
    display: flex;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[2.5]};
    padding: ${({theme}) => theme.space[1]} 0;
`

const Check = styled.input`
    flex: none;
    margin: ${({theme}) => theme.space[0.5]} 0 0;
    accent-color: ${({theme}) => theme.colors.text};
    cursor: pointer;
    ${focusRing};
`

// The text opens the item for editing; it reads as text, not as a button.
const ItemText = styled.button<{ $done: boolean }>`
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: none;
    color: ${({theme, $done}) => ($done ? theme.colors.muted : theme.colors.text)};
    ${({theme}) => theme.text.body};
    text-align: left;
    text-decoration: ${({$done}) => ($done ? 'line-through' : 'none')};
    overflow-wrap: anywhere;
    cursor: text;
    ${colorTransition};
    ${focusRing};
`

const Meta = styled.span`
    color: ${({theme}) => theme.colors.muted};
`

const Fields = styled.form`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3]};
`

const FORM_ID = 'action-item'

/** "· Priya · Fri", "· no owner yet": the owner as written, or the contact native matched. */
function meta(item: ActionItem): string {
    const owner = item.personName ?? item.ownerLabel
    return [owner || 'no owner yet', item.dueText].filter(Boolean).map((part) => `· ${part}`).join(' ')
}

interface ActionItemsProps {
    meetingId: string
    /** Plays the recording from where an item was said; absent without audio. */
    onPlayFrom?: (seconds: number) => void
}

/**
 * The meeting's action items under its summary, as rows of their own: a
 * new summary's action section moves into them (actionItemSync.ts). Each
 * can be checked off, played from where it was said, reworded, given an
 * owner and a due date, or deleted; the user adds their own.
 */
export function ActionItems({meetingId, onPlayFrom}: ActionItemsProps) {
    const items = useQuery(actionItemsQuery({meetingId}))
    const update = useMutation(updateActionItemMutation)
    const [editing, setEditing] = useState<{ open: boolean, item: ActionItem | null }>({open: false, item: null})

    const toggle = (item: ActionItem) => update.mutate({...item, done: !item.done}, {
        onError: (error) => toast.error('Couldn’t update the action item', {description: error.message}),
    })

    return (
        <Section aria-labelledby="summary-action-items">
            <SummaryHeading id="summary-action-items">Action items</SummaryHeading>
            {items.isError && <Meta role="alert">Couldn’t load the action items: {items.error.message}</Meta>}
            {items.data && items.data.length > 0 && (
                <List>
                    {items.data.map((item) => (
                        <Row key={item.id}>
                            <Check
                                type="checkbox"
                                checked={item.done}
                                aria-label={item.done ? `Mark “${item.text}” as not done` : `Mark “${item.text}” as done`}
                                onChange={() => toggle(item)}
                            />
                            <ItemText type="button" $done={item.done} title="Edit" onClick={() => setEditing({open: true, item})}>
                                {item.text} <Meta>{meta(item)}</Meta>
                            </ItemText>
                            {onPlayFrom && item.audioTime != null && (
                                <IconButton size="sm" label={`Play from ${formatClock(item.audioTime)}`} onClick={() => onPlayFrom(item.audioTime ?? 0)}>
                                    <PlayIcon aria-hidden/>
                                </IconButton>
                            )}
                        </Row>
                    ))}
                </List>
            )}
            <Button size="sm" variant="ghost" onClick={() => setEditing({open: true, item: null})}>
                <PlusIcon aria-hidden/>
                Add an action item
            </Button>
            <ActionItemSheet
                meetingId={meetingId}
                open={editing.open}
                item={editing.item}
                onOpenChange={(open) => setEditing((current) => ({...current, open}))}
            />
        </Section>
    )
}

interface Draft {
    text: string
    owner: string
    due: string
}

const draftOf = (item: ActionItem | null): Draft => ({text: item?.text ?? '', owner: item?.ownerLabel ?? '', due: item?.dueText ?? ''})

function ActionItemSheet({meetingId, open, item, onOpenChange}: {
    meetingId: string
    open: boolean
    /** The item to edit; null adds one. Kept while the sheet closes. */
    item: ActionItem | null
    onOpenChange: (open: boolean) => void
}) {
    const remove = useMutation(deleteActionItemMutation)
    const create = useMutation(createActionItemMutation(meetingId))
    const update = useMutation(updateActionItemMutation)
    const saving = create.isPending || update.isPending
    // The footer's Save needs the text, so the draft lives here. Each opening
    // starts from the item it opens (by id: a refetch while open keeps the typing).
    const [draft, setDraft] = useState(() => draftOf(item))
    const opening = open ? item?.id ?? 'new' : null
    const [openedFor, setOpenedFor] = useState(opening)
    if (opening !== openedFor) {
        setOpenedFor(opening)
        if (opening !== null) setDraft(draftOf(item))
    }

    const submit = (event: FormEvent) => {
        event.preventDefault()
        if (saving) return
        const fields = {text: draft.text.trim(), ownerLabel: draft.owner.trim() || undefined, dueText: draft.due.trim() || undefined}
        if (!fields.text) return
        const onSuccess = () => onOpenChange(false)
        const onError = (error: Error) => toast.error('Couldn’t save the action item', {description: error.message})
        // A new owner name is matched to a contact again by native.
        if (item) update.mutate({...item, ...fields, personId: fields.ownerLabel === item.ownerLabel ? item.personId : undefined}, {onSuccess, onError})
        else create.mutate(fields, {onSuccess, onError})
    }

    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={item ? 'Edit action item' : 'Add an action item'}
            footer={(
                <>
                    {item && (
                        <Button
                            variant="ghost"
                            pending={remove.isPending}
                            onClick={() => remove.mutate(item.id, {
                                onSuccess: () => onOpenChange(false),
                                onError: (error) => toast.error('Couldn’t delete the action item', {description: error.message}),
                            })}
                        >
                            Delete
                        </Button>
                    )}
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button variant="filled" type="submit" form={FORM_ID} pending={saving} disabled={!draft.text.trim()}>
                        {item ? 'Save' : 'Add'}
                    </Button>
                </>
            )}
        >
            <Fields id={FORM_ID} onSubmit={submit}>
                <TextField label="What needs doing" autoFocus value={draft.text} onChange={(event) => setDraft({...draft, text: event.target.value})}/>
                <TextField label="Owner" hint="Optional" placeholder="Priya" value={draft.owner} onChange={(event) => setDraft({...draft, owner: event.target.value})}/>
                <TextField label="Due" hint="Optional, as you would say it" placeholder="Friday" value={draft.due} onChange={(event) => setDraft({...draft, due: event.target.value})}/>
            </Fields>
        </Sheet>
    )
}
