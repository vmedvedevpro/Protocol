import {useMutation} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {deleteMeetingMutation} from '@/api/meetings'
import {Button} from '@/components/ui/Button'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {toast} from '@/components/ui/toastStore'
import {paths} from '@/lib/paths'

const Text = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.soft};
`

/** Deletes the meeting after asking, then returns to the list. The audio files stay. */
export function DeleteMeetingSheet({meetingId, open, onOpenChange}: {
    meetingId: string
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const navigate = useNavigate()
    const remove = useMutation(deleteMeetingMutation(meetingId))
    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title="Delete this meeting?"
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button
                        variant="filled"
                        pending={remove.isPending}
                        onClick={() => remove.mutate(undefined, {
                            onSuccess: () => {
                                toast.success('Meeting deleted')
                                void navigate(paths.home, {replace: true})
                            },
                            onError: (error) => toast.error('Couldn’t delete the meeting', {description: error.message}),
                        })}
                    >
                        Delete meeting
                    </Button>
                </>
            )}
        >
            <Text>The transcript, summary, notes and action items are removed. Audio files stay in your recordings folder.</Text>
        </Sheet>
    )
}
