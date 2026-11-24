import {type FormEvent, useState} from 'react'
import {useMutation} from '@tanstack/react-query'
import styled from 'styled-components'
import {createFolderMutation, deleteFolderMutation, type Folder, renameFolderMutation} from '@/api/meetings'
import {Button} from '@/components/ui/Button'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {TextField} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'

const Problem = styled.p`
    margin: ${({theme}) => theme.space[1.5]} 0 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.text};
`

const Text = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.soft};
`

const FORM_ID = 'folder-name'

/**
 * Names a new folder, or renames `folder`. Native refuses a blank name and
 * one another folder has; the sheet stays open and says so.
 */
export function FolderNameSheet({open, onOpenChange, folder, onCreated}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** The folder to rename; none names a new one. */
    folder?: Folder | null
    onCreated?: (folder: Folder) => void
}) {
    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={folder ? 'Rename folder' : 'New folder'}
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button variant="filled" type="submit" form={FORM_ID}>{folder ? 'Save' : 'Create folder'}</Button>
                </>
            )}
        >
            <NameForm folder={folder ?? null} onDone={() => onOpenChange(false)} onCreated={onCreated}/>
        </Sheet>
    )
}

// Its own component, so each opening starts from the folder's name.
function NameForm({folder, onDone, onCreated}: {
    folder: Folder | null
    onDone: () => void
    onCreated?: (folder: Folder) => void
}) {
    const [name, setName] = useState(folder?.name ?? '')
    const create = useMutation(createFolderMutation)
    const rename = useMutation(renameFolderMutation)
    const pending = create.isPending || rename.isPending
    const error = create.error ?? rename.error

    const submit = (event: FormEvent) => {
        event.preventDefault()
        if (pending) return
        const trimmed = name.trim()
        if (folder) {
            if (trimmed === folder.name) return onDone()
            rename.mutate({folder, name: trimmed}, {onSuccess: onDone})
        } else {
            create.mutate(trimmed, {
                onSuccess: (created) => {
                    onDone()
                    onCreated?.(created)
                },
            })
        }
    }

    return (
        <form id={FORM_ID} onSubmit={submit}>
            <TextField
                label="Name"
                autoFocus
                value={name}
                placeholder="Acme Corp"
                aria-invalid={!!error}
                onChange={(event) => {
                    setName(event.target.value)
                    create.reset()
                    rename.reset()
                }}
            />
            {error && <Problem role="alert">{error.message}</Problem>}
        </form>
    )
}

/** Deletes a folder after asking; its meetings stay, in no folder. */
export function DeleteFolderSheet({open, folder, onOpenChange, onDeleted}: {
    open: boolean
    folder: Folder | null
    onOpenChange: (open: boolean) => void
    onDeleted: (folder: Folder) => void
}) {
    const remove = useMutation(deleteFolderMutation)
    const count = folder?.meetingCount ?? 0
    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={`Delete “${folder?.name ?? ''}”?`}
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button
                        variant="filled"
                        pending={remove.isPending}
                        onClick={() => folder && remove.mutate(folder.id, {
                            onSuccess: () => {
                                onOpenChange(false)
                                onDeleted(folder)
                            },
                            onError: (error) => toast.error('Couldn’t delete the folder', {description: error.message}),
                        })}
                    >
                        Delete folder
                    </Button>
                </>
            )}
        >
            <Text>
                {count
                    ? `Its ${count === 1 ? 'meeting stays' : `${count} meetings stay`} in the list, in no folder.`
                    : 'The folder is empty.'}
            </Text>
        </Sheet>
    )
}
