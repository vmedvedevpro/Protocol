import {useMemo} from 'react'
import {useMutation, useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {meetingTranscriptsQuery, renameSpeakerMutation} from '@/api/meetings'
import {usePostCallJob} from '@/api/postCall'
import {useUserName} from '@/api/preferences'
import {type PlaybackClock, TranscriptList} from '@/components/transcript/TranscriptList'
import {lineFromSegment} from '@/components/transcript/turns'
import {Button} from '@/components/ui/Button'
import {Spinner} from '@/components/ui/Spinner'
import {toast} from '@/components/ui/toastStore'

const Column = styled.div`
    display: flex;
    flex-direction: column;
    height: 100%;
`

const Note = styled.p`
    margin: 0 ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[1.5]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Centered = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[6]} ${({theme}) => theme.space[4]};
    text-align: center;
`

const Muted = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.muted};
`

interface TranscriptPanelProps {
    meetingId: string
    playback?: PlaybackClock
    /** The recording plays: the highlighted turn is kept in view. */
    playing: boolean
    onSeek?: (seconds: number) => void
}

/**
 * The Transcript tab: every line as it was said, joined into turns, with
 * the turn being played highlighted. A time plays from there; an unnamed
 * voice can be named, on every line of the meeting. While the post-call
 * pass runs, the text is the live one, and a note says a better one comes.
 */
export function TranscriptPanel({meetingId, playback, playing, onSeek}: TranscriptPanelProps) {
    const transcript = useQuery(meetingTranscriptsQuery(meetingId))
    const rename = useMutation(renameSpeakerMutation(meetingId))
    const job = usePostCallJob(meetingId)
    const userName = useUserName()
    const lines = useMemo(() => (transcript.data ?? []).map(lineFromSegment), [transcript.data])

    if (transcript.isPending) return <Column><Centered aria-busy="true"><Spinner delayed/></Centered></Column>
    if (transcript.isError) {
        return (
            <Column>
                <Centered role="alert">
                    <Muted>Couldn’t load the transcript: {transcript.error.message}</Muted>
                    <Button size="sm" onClick={() => void transcript.refetch()}>Try again</Button>
                </Centered>
            </Column>
        )
    }

    return (
        <Column>
            <TranscriptList
                lines={lines}
                label="Transcript"
                userName={userName || undefined}
                playback={playback}
                followPlayback={playing}
                onSeek={onSeek}
                // The pass replaces the lines and their labels; a name given meanwhile would be lost.
                onRenameSpeaker={job ? undefined : (from, to) => rename.mutateAsync({from, to}).catch((error: unknown) => {
                    toast.error('Couldn’t rename the speaker', {description: errorMessage(error)})
                    throw error
                })}
                before={job ? <Note>This is the live text. A cleaner transcript with speakers replaces it in a moment.</Note> : undefined}
                empty={<Centered><Muted>Nothing was transcribed in this meeting.</Muted></Centered>}
            />
        </Column>
    )
}
