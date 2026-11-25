import {useState} from 'react'
import styled from 'styled-components'
import {Button} from '@/components/ui/Button'
import {Sheet, SheetClose} from '@/components/ui/Sheet'

const Text = styled.p`
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.muted};
`

/**
 * Asks before a model is removed: "Remove model?" and "Remove NVIDIA
 * Nemotron?" of the old app. Remove stays pending until `onRemove` settles,
 * then the sheet closes; a failure is the caller's toast.
 */
export function RemoveSheet({open, onOpenChange, name, detail, onRemove}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    name: string
    /** What removing it frees or changes; "You can download it again at any time" follows. */
    detail?: string
    onRemove: () => Promise<unknown>
}) {
    const [pending, setPending] = useState(false)
    const remove = () => {
        setPending(true)
        void onRemove().finally(() => {
            setPending(false)
            onOpenChange(false)
        })
    }
    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={`Remove ${name}?`}
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button variant="filled" pending={pending} onClick={remove}>Remove</Button>
                </>
            )}
        >
            <Text>{detail ? `${detail} ` : ''}You can download it again at any time.</Text>
        </Sheet>
    )
}
