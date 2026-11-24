import {type FormEvent, useState} from 'react'
import {useMutation} from '@tanstack/react-query'
import {renameMeetingMutation} from '@/api/meetings'
import {Button} from '@/components/ui/Button'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {TextField} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'

const FORM_ID = 'meeting-title'

/**
 * Renames a meeting: from its header's menu, and F2 on its row in the list.
 * Native marks the title manual, so a summary never renames it afterwards.
 */
export function RenameMeetingSheet({open, meeting, onOpenChange}: {
    open: boolean
    /** The meeting to rename; kept while the sheet closes. */
    meeting: { id: string, title: string } | null
    onOpenChange: (open: boolean) => void
}) {
    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title="Rename meeting"
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button variant="filled" type="submit" form={FORM_ID}>Save</Button>
                </>
            )}
        >
            {meeting && <TitleForm key={meeting.id} meeting={meeting} onDone={() => onOpenChange(false)}/>}
        </Sheet>
    )
}

function TitleForm({meeting, onDone}: { meeting: { id: string, title: string }, onDone: () => void }) {
    const [title, setTitle] = useState(meeting.title)
    const rename = useMutation(renameMeetingMutation(meeting.id))

    const submit = (event: FormEvent) => {
        event.preventDefault()
        const trimmed = title.trim()
        if (!trimmed || trimmed === meeting.title) return onDone()
        rename.mutate(trimmed, {
            onSuccess: onDone,
            onError: (error) => toast.error('Couldn’t rename the meeting', {description: error.message}),
        })
    }

    return (
        <form id={FORM_ID} onSubmit={submit}>
            <TextField
                label="Title"
                autoFocus
                value={title}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setTitle(event.target.value)}
            />
        </form>
    )
}
