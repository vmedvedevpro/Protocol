import {useEffect, useState} from 'react'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {SpacedParts} from '@/components/ui/SpacedParts'
import {Button} from '@/components/ui/Button'
import {Sheet} from '@/components/ui/Sheet'
import {toast} from '@/components/ui/toastStore'
import {deleteRecovery} from '../api/recovery'
import {startedLabel} from '../lib/titles'
import {links} from '../store/links'
import {claimRecoveryOffer, findRecoverable, type RecoverableMeeting, recoverMeeting} from '../store/recover'

const List = styled.ul`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2]};
    margin: 0;
    padding: 0;
    list-style: none;
`

const Item = styled.li`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[1.5]};
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.md};
`

const Name = styled.h3`
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

const Meta = styled(SpacedParts)`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Preview = styled.p`
    display: -webkit-box;
    overflow: hidden;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.soft};
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
`

const Actions = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

const Confirm = styled.span`
    flex: 1;
    ${({theme}) => theme.text.small};
`

const linesLabel = (count: number) => `${count} ${count === 1 ? 'line' : 'lines'}`

function RecoverableItem({meeting, onDone}: { meeting: RecoverableMeeting, onDone: (meetingId: string) => void }) {
    const [confirming, setConfirming] = useState(false)
    const [pending, setPending] = useState<'recover' | 'delete' | null>(null)

    const recover = async () => {
        setPending('recover')
        try {
            const {meetingId, audio} = await recoverMeeting(meeting.meetingId)
            const audioNote = !audio ? 'Its audio was not kept.'
                : audio.status === 'success' ? 'Its audio was rebuilt too.'
                    : audio.status === 'partial' ? 'Part of its audio was rebuilt.'
                        : 'Its audio could not be rebuilt.'
            toast.success('Meeting recovered', {
                description: `${meeting.title}. ${audioNote}`,
                action: {label: 'Open', onClick: () => links.openMeeting(meetingId)},
            })
            onDone(meeting.meetingId)
        } catch (error) {
            toast.error('Could not recover the meeting', {description: errorMessage(error)})
            setPending(null)
        }
    }

    const remove = async () => {
        setPending('delete')
        try {
            await deleteRecovery(meeting.meetingId)
            onDone(meeting.meetingId)
        } catch (error) {
            toast.error('Could not delete the meeting', {description: errorMessage(error)})
            setPending(null)
            setConfirming(false)
        }
    }

    return (
        <Item aria-label={meeting.title}>
            <Name>{meeting.title || 'Untitled meeting'}</Name>
            <Meta parts={[startedLabel(new Date(meeting.startTime)), linesLabel(meeting.lines), meeting.audio && 'audio can be rebuilt']}/>
            {meeting.preview && <Preview>{meeting.preview}</Preview>}
            <Actions>
                {confirming ? (
                    <>
                        <Confirm>Delete this meeting for good?</Confirm>
                        <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => setConfirming(false)}>Keep</Button>
                        <Button size="sm" pending={pending === 'delete'} onClick={() => void remove()}>Delete</Button>
                    </>
                ) : (
                    <>
                        <Button size="sm" variant="filled" pending={pending === 'recover'} disabled={pending !== null} onClick={() => void recover()}>
                            Recover
                        </Button>
                        <Button size="sm" variant="ghost" disabled={pending !== null} onClick={() => setConfirming(true)}>Delete</Button>
                    </>
                )}
            </Actions>
        </Item>
    )
}

/**
 * Meetings a crash or a failed save left unsaved, offered once per session:
 * each can be recovered (saved from its crash copy, with its audio when
 * checkpoints are left) or deleted after a confirm. Closing keeps them for
 * the next session, until they are 7 days old.
 */
export function RecoverySheet() {
    const [meetings, setMeetings] = useState<RecoverableMeeting[]>([])
    const [open, setOpen] = useState(false)

    useEffect(() => {
        if (!claimRecoveryOffer()) return
        void findRecoverable()
            .then((found) => {
                setMeetings(found)
                setOpen(found.length > 0)
            })
            .catch(() => undefined)
    }, [])

    const done = (meetingId: string) => {
        const left = meetings.filter((meeting) => meeting.meetingId !== meetingId)
        setMeetings(left)
        if (left.length === 0) setOpen(false)
    }

    return (
        <Sheet
            open={open}
            onOpenChange={setOpen}
            title={meetings.length === 1 ? 'An interrupted meeting' : 'Interrupted meetings'}
            description="Protocol closed before these were saved. Recover them from what was transcribed, or delete them."
        >
            <List>
                {meetings.map((meeting) => <RecoverableItem key={meeting.meetingId} meeting={meeting} onDone={done}/>)}
            </List>
        </Sheet>
    )
}
