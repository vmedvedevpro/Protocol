import {useCallback, useMemo} from 'react'
import {UserIcon, UserSwitchIcon} from '@phosphor-icons/react'
import {useMutation, useQuery} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {meetingTranscriptsQuery, renameSpeakerMutation} from '@/api/meetings'
import {peopleQuery, personForSpeaker} from '@/api/people'
import {usePostCallJob} from '@/api/postCall'
import {useUserName} from '@/api/preferences'
import {type PlaybackClock, type SpeakerAction, type SpeakerTarget, TranscriptList} from '@/components/transcript/TranscriptList'
import {lineFromSegment} from '@/components/transcript/turns'
import {Button} from '@/components/ui/Button'
import {Spinner} from '@/components/ui/Spinner'
import {toast} from '@/components/ui/toastStore'
import {openDialog} from '@/lib/dialogs'
import {paths} from '@/lib/paths'

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
    /** A line to scroll into view once (a search result's). */
    revealLine?: string
    /** Labs › Clean transcript: how each turn is shown (`cleanTranscriptText`). */
    clean?: (text: string) => string
}

/**
 * The Transcript tab: every line as it was said, joined into turns, with
 * the turn being played highlighted. A time plays from there; a voice's
 * label opens its contact (#118) and names it, on every line of the meeting. While the post-call
 * pass runs, the text is the live one, and a note says a better one comes.
 */
export function TranscriptPanel({meetingId, playback, playing, onSeek, revealLine, clean}: TranscriptPanelProps) {
    const transcript = useQuery(meetingTranscriptsQuery(meetingId))
    const rename = useMutation(renameSpeakerMutation(meetingId))
    const job = usePostCallJob(meetingId)
    const userName = useUserName()
    const lines = useMemo(() => (transcript.data ?? []).map(lineFromSegment), [transcript.data])
    const navigate = useNavigate()
    const people = useQuery(peopleQuery)
    // Open <contact> when the voice is one (#118), then Who said this…
    // (features/dialogs, #119). Stable while the contacts are, so the turns
    // keep their memo.
    const speakerActions = useCallback((target: SpeakerTarget) => {
        const person = personForSpeaker(people.data ?? [], target.speaker)
        const actions: SpeakerAction[] = []
        if (person) actions.push({id: 'open-person', label: `Open ${person.displayName}`, icon: <UserIcon/>, onSelect: () => void navigate(paths.person(person.id))})
        if (!job) actions.push({id: 'who-said-this', label: 'Who said this…', icon: <UserSwitchIcon aria-hidden/>, onSelect: () => openDialog({kind: 'speaker', meetingId, ...target})})
        return actions
    }, [people.data, navigate, meetingId, job])

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
                clean={clean}
                label="Transcript"
                userName={userName || undefined}
                playback={playback}
                followPlayback={playing}
                revealLineId={revealLine}
                onSeek={onSeek}
                // The pass replaces the lines and their labels; a name given meanwhile would be lost.
                onRenameSpeaker={job ? undefined : (from, to) => rename.mutateAsync({from, to}).catch((error: unknown) => {
                    toast.error('Couldn’t rename the speaker', {description: errorMessage(error)})
                    throw error
                })}
                speakerActions={speakerActions}
                before={job ? <Note>This is the live text. A cleaner transcript with speakers replaces it in a moment.</Note> : undefined}
                empty={<Centered><Muted>Nothing was transcribed in this meeting.</Muted></Centered>}
            />
        </Column>
    )
}
