import {useState} from 'react'
import {ArrowClockwiseIcon, CopyIcon} from '@phosphor-icons/react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {useNavigate, useParams, useSearchParams} from 'react-router-dom'
import styled from 'styled-components'
import {actionItemsQuery} from '@/api/actionItems'
import {
    foldersQuery,
    isSummaryRunning,
    meetingFolderQuery,
    meetingQuery,
    meetingsQuery,
    meetingTranscriptsQuery,
    openMeetingFolder,
    setMeetingFolderMutation,
    summaryQuery,
} from '@/api/meetings'
import {usePostCallJob} from '@/api/postCall'
import {useUserName} from '@/api/preferences'
import {Screen} from '@/components/screen/Screen'
import {Button, IconButton} from '@/components/ui/Button'
import {TabList, TabPanels, Tabs} from '@/components/ui/SegmentedControl'
import {Spinner} from '@/components/ui/Spinner'
import {toast} from '@/components/ui/toastStore'
import {useHotkey} from '@/lib/hotkeys'
import {paths} from '@/lib/paths'
import {FolderNameSheet} from '../components/FolderSheets'
import {ProcessingStatus} from '../components/processing/ProcessingStatus'
import {RenameMeetingSheet} from '../components/RenameMeetingSheet'
import {meetingDocument, summaryMarkdown, transcriptMarkdown} from '../lib/copyText'
import {parseDate} from '../lib/dates'
import {completeSummaryMarkdown, parseSummaryData} from '../lib/summaryMarkdown'
import {MeetingHeader} from './MeetingHeader'
import {DeleteMeetingSheet, WriteAgainSheet} from './MeetingSheets'
import {NotesPanel} from './NotesPanel'
import {useMeetingPlayer} from './player'
import {PlayerBar} from './PlayerBar'
import {useIdentifySpeakers} from './identifySpeakers'
import {SpeakerCount} from './SpeakerCount'
import {useWriteSummary} from './summaryRun'
import {SummaryPanel} from './SummaryPanel'
import {TranscriptPanel} from './TranscriptPanel'

type MeetingTab = 'notes' | 'transcript' | 'summary'

const TABS: { value: MeetingTab, label: string }[] = [
    {value: 'notes', label: 'Notes'},
    {value: 'transcript', label: 'Transcript'},
    {value: 'summary', label: 'Summary'},
]

const isTab = (value: string | null): value is MeetingTab => TABS.some((tab) => tab.value === value)

const Status = styled(ProcessingStatus)`
    margin: 0 ${({theme}) => theme.space[4]} ${({theme}) => theme.space[2.5]};
`

const Row = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    padding: 0 ${({theme}) => theme.space[3]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[4]};
    border-bottom: 1px solid ${({theme}) => theme.colors.border};
`

const Spacer = styled.span`
    flex: 1;
`

const Actions = styled.div`
    display: flex;
    gap: ${({theme}) => theme.space[0.5]};
`

const Body = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
`

const Centered = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[9]};
    text-align: center;
`

const Heading = styled.h1`
    margin: 0;
    ${({theme}) => theme.text.heading};
`

const Muted = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.muted};
`

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** `/meetings/:meetingId`: the route reads the id; the screen renders once per meeting. */
export function MeetingRoute() {
    const {meetingId = ''} = useParams()
    return <MeetingScreen key={meetingId} meetingId={meetingId}/>
}

/**
 * One meeting after its recording: the header and its menu, the post-call
 * pass while it runs, the Notes, Transcript and Summary tabs (⌘1, ⌘2, ⌘3,
 * kept in the URL as `?tab=`), and the player docked at the bottom.
 */
export function MeetingScreen({meetingId}: { meetingId: string }) {
    const client = useQueryClient()
    const navigate = useNavigate()
    const [params, setParams] = useSearchParams()
    const userName = useUserName()

    const meeting = useQuery(meetingQuery(meetingId))
    const listed = useQuery({...meetingsQuery, select: (list) => list.find((item) => item.id === meetingId)})
    const folder = useQuery(meetingFolderQuery(meetingId))
    const folders = useQuery(foldersQuery)
    const transcript = useQuery(meetingTranscriptsQuery(meetingId))
    const summary = useQuery(summaryQuery(meetingId))
    const job = usePostCallJob(meetingId)
    const move = useMutation(setMeetingFolderMutation(meetingId))
    const {player, state: playback} = useMeetingPlayer(meetingId)
    const hasAudio = playback.status !== 'unavailable' && playback.status !== 'error'
    const speakers = useIdentifySpeakers(meetingId, hasAudio)
    const {write, starting} = useWriteSummary(meetingId)

    const [renaming, setRenaming] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [naming, setNaming] = useState(false)
    const [confirmingWrite, setConfirmingWrite] = useState(false)

    const requested = params.get('tab')
    const tab: MeetingTab = isTab(requested) ? requested : 'summary'
    const selectTab = (next: MeetingTab) => setParams((current) => {
        const updated = new URLSearchParams(current)
        updated.set('tab', next)
        return updated
    }, {replace: true})

    useHotkey({code: 'Digit1', mod: true}, () => selectTab('notes'))
    useHotkey({code: 'Digit2', mod: true}, () => selectTab('transcript'))
    useHotkey({code: 'Digit3', mod: true}, () => selectTab('summary'))
    useHotkey({code: 'F2'}, () => setRenaming(true), {enabled: meeting.isSuccess})

    const title = meeting.data?.title ?? listed.data?.title ?? ''
    const createdAt = parseDate(meeting.data?.created_at ?? listed.data?.created_at)
    const lines = transcript.data ?? []
    const summaryText = completeSummaryMarkdown(parseSummaryData(summary.data?.data)).trim()
    const summaryBusy = !!job || starting || isSummaryRunning(summary.data?.status)

    const copy = async (what: 'transcript' | 'summary') => {
        try {
            let body: string
            if (what === 'transcript') {
                body = transcriptMarkdown(await client.fetchQuery(meetingTranscriptsQuery(meetingId)), userName || undefined)
                if (!body) return void toast.info('There is no transcript to copy yet')
            } else {
                const [stored, items] = await Promise.all([
                    client.fetchQuery(summaryQuery(meetingId)),
                    client.fetchQuery(actionItemsQuery({meetingId})),
                ])
                body = summaryMarkdown(stored.data, items)
                if (!body) return void toast.info('There is no summary to copy yet')
            }
            await navigator.clipboard.writeText(meetingDocument(title, createdAt, [[what === 'transcript' ? 'Transcript' : 'Summary', body]]))
            toast.success(what === 'transcript' ? 'Transcript copied' : 'Summary copied')
        } catch (error) {
            toast.error(`Couldn’t copy the ${what}`, {description: message(error)})
        }
    }

    const writeAgain = () => {
        if (summary.data?.userEdited) setConfirmingWrite(true)
        else void write({again: true})
    }

    if (meeting.isError) {
        return (
            <Screen>
                <Centered role="alert">
                    <Heading>This meeting isn’t available</Heading>
                    <Muted>{message(meeting.error)}</Muted>
                    <Button size="sm" onClick={() => void navigate(paths.home)}>Back to meetings</Button>
                </Centered>
            </Screen>
        )
    }
    if (meeting.isPending) {
        return <Screen><Centered aria-busy="true"><Spinner delayed/></Centered></Screen>
    }

    return (
        <Screen bar={<PlayerBar player={player} {...playback}/>}>
            <MeetingHeader
                title={title}
                createdAt={createdAt}
                durationSeconds={listed.data?.duration_seconds}
                folder={folder.data ?? null}
                folders={folders.data ?? []}
                hasRecordingFolder={!!meeting.data.folder_path}
                hasSummary={!!summaryText}
                canIdentifySpeakers={speakers.available && !speakers.running}
                onRename={() => setRenaming(true)}
                onMove={(folderId) => move.mutate(folderId, {
                    onError: (error) => toast.error('Couldn’t move the meeting', {description: error.message}),
                })}
                onNewFolder={() => setNaming(true)}
                onCopyTranscript={() => void copy('transcript')}
                onCopySummary={() => void copy('summary')}
                onOpenRecordingFolder={() => void openMeetingFolder(meetingId).catch((error: unknown) =>
                    toast.error('Couldn’t open the recording folder', {description: message(error)}))}
                onIdentifySpeakers={speakers.identify}
                onDelete={() => setDeleting(true)}
            />
            <Status meetingId={meetingId}/>
            <Tabs label="Meeting views" options={TABS} value={tab} onChange={selectTab}>
                <Row>
                    <TabList/>
                    <Spacer/>
                    {tab === 'transcript' && speakers.available && (
                        <SpeakerCount lines={lines} running={speakers.running} onPick={speakers.identify}/>
                    )}
                    {tab === 'summary' && !summaryBusy && summaryText && (
                        <Actions>
                            <IconButton label="Copy summary" onClick={() => void copy('summary')}>
                                <CopyIcon size={15} aria-hidden/>
                            </IconButton>
                            <IconButton label="Write the summary again" onClick={writeAgain}>
                                <ArrowClockwiseIcon size={15} aria-hidden/>
                            </IconButton>
                        </Actions>
                    )}
                </Row>
                <Body>
                    <TabPanels<MeetingTab>>
                        {(view) => {
                            if (view === 'notes') return <NotesPanel meetingId={meetingId}/>
                            if (view === 'transcript') {
                                return (
                                    <TranscriptPanel
                                        meetingId={meetingId}
                                        playback={hasAudio ? player.clock : undefined}
                                        playing={playback.playing}
                                        onSeek={playback.status === 'ready' ? player.playFrom : undefined}
                                    />
                                )
                            }
                            return (
                                <SummaryPanel
                                    meetingId={meetingId}
                                    canWrite={lines.length > 0}
                                    starting={starting}
                                    onWrite={() => void write()}
                                    onPlayFrom={playback.status === 'ready' ? player.playFrom : undefined}
                                />
                            )
                        }}
                    </TabPanels>
                </Body>
            </Tabs>
            <RenameMeetingSheet open={renaming} meeting={{id: meetingId, title}} onOpenChange={setRenaming}/>
            <DeleteMeetingSheet meetingId={meetingId} open={deleting} onOpenChange={setDeleting}/>
            <FolderNameSheet
                open={naming}
                onOpenChange={setNaming}
                onCreated={(created) => move.mutate(created.id)}
            />
            <WriteAgainSheet open={confirmingWrite} onOpenChange={setConfirmingWrite} onConfirm={() => void write({again: true})}/>
        </Screen>
    )
}
