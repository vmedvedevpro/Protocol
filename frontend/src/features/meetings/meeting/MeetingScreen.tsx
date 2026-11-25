import {useEffect, useState} from 'react'
import {ArrowClockwiseIcon, CopyIcon} from '@phosphor-icons/react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {useLocation, useNavigate, useParams, useSearchParams} from 'react-router-dom'
import styled from 'styled-components'
import {actionItemsQuery} from '@/api/actionItems'
import {errorMessage} from '@/api/core'
import {
    foldersQuery,
    isSummaryRunning,
    meetingAudioQuery,
    meetingFolderQuery,
    meetingQuery,
    meetingsQuery,
    meetingTranscriptsQuery,
    openMeetingFolder,
    setMeetingFolderMutation,
    summaryQuery,
} from '@/api/meetings'
import {useLab, waveformQuery} from '@/api/labs'
import {usePostCallJob} from '@/api/postCall'
import {useUserName} from '@/api/preferences'
import {Screen} from '@/components/screen/Screen'
import {useWriteSummary} from '@/components/summary/writeSummary'
import {meetingDocument, summaryMarkdown, transcriptMarkdown} from '@/components/transcript/meetingText'
import {Button, IconButton} from '@/components/ui/Button'
import {SegmentedControl, TabList, TabPanels, Tabs} from '@/components/ui/SegmentedControl'
import {Spinner} from '@/components/ui/Spinner'
import {toast} from '@/components/ui/toastStore'
import {openDialog} from '@/lib/dialogs'
import {useHotkey} from '@/lib/hotkeys'
import {cleanTranscriptText} from '@/lib/cleanTranscript'
import {paths} from '@/lib/paths'
import {completeSummaryMarkdown, parseSummaryData} from '@/lib/summaryMarkdown'
import {FolderNameSheet} from '../components/FolderSheets'
import {ProcessingStatus} from '../components/processing/ProcessingStatus'
import {RenameMeetingSheet} from '../components/RenameMeetingSheet'
import {parseDate} from '@/lib/dates'
import {MeetingHeader} from './MeetingHeader'
import {DeleteMeetingSheet} from './MeetingSheets'
import {NotesPanel} from './NotesPanel'
import {SLOW_PLAYBACK_RATES, useMeetingPlayer} from './player'
import {PlayerBar} from './PlayerBar'
import {useIdentifySpeakers} from './identifySpeakers'
import {SpeakerCount} from './SpeakerCount'
import {SummaryPanel} from './SummaryPanel'
import {TranscriptPanel} from './TranscriptPanel'

type MeetingTab = 'notes' | 'transcript' | 'summary'

type TextMode = 'clean' | 'verbatim'

/** Labs › Clean transcript: the text as shown; the saved one never changes. */
const TEXT_MODES: { value: TextMode, label: string }[] = [
    {value: 'clean', label: 'Clean'},
    {value: 'verbatim', label: 'Verbatim'},
]

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

interface Moment {
    /** Seconds into the recording, or null. */
    at: number | null
    line?: string
    /** The navigation that asked, so the same request twice reveals twice. */
    key: string
}

/** What a navigation asks to be shown (`?at=`, `?line=`), if anything. */
function momentOf(params: URLSearchParams, key: string): Moment | null {
    const seconds = Number(params.get('at') ?? Number.NaN)
    const at = Number.isFinite(seconds) && seconds >= 0 ? seconds : null
    const line = params.get('line') ?? undefined
    return at === null && line === undefined ? null : {at, line, key}
}

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
    // Only the list knows a meeting's length (its last line's end).
    const listed = useQuery({...meetingsQuery, select: (list) => list.find((item) => item.id === meetingId)})
    const folder = useQuery(meetingFolderQuery(meetingId))
    const folders = useQuery(foldersQuery)
    const transcript = useQuery(meetingTranscriptsQuery(meetingId))
    const summary = useQuery(summaryQuery(meetingId))
    const job = usePostCallJob(meetingId)
    const move = useMutation({
        ...setMeetingFolderMutation(meetingId),
        onError: (error) => toast.error('Couldn’t move the meeting', {description: error.message}),
    })
    const {player, state: playback} = useMeetingPlayer(meetingId)
    // Native says whether the meeting has a recording; whether this WebView
    // can play it only switches the player off. Improve and Identify speakers
    // read the file in native code, so a playback error leaves them in place.
    const audio = useQuery(meetingAudioQuery(meetingId)).data
    const audioPath = audio?.path ?? null
    const hasAudio = !!audioPath
    const playable = playback.status !== 'unavailable' && playback.status !== 'error'
    // Labs: the waveform and slow speeds in the player, the clean text with its Clean/Verbatim switch.
    const scrubbing = useLab('transcriptScrubbing')
    const cleanLab = useLab('cleanTranscript')
    const [textMode, setTextMode] = useState<TextMode>('clean')
    const peaks = useQuery({...waveformQuery(audioPath ?? ''), enabled: scrubbing && !!audioPath}).data
    const speakers = useIdentifySpeakers(meetingId, hasAudio)
    const identifySpeakers = () => openDialog({kind: 'identify-speakers', identify: speakers.identify})
    const {write, starting} = useWriteSummary(meetingId)

    const [renaming, setRenaming] = useState(false)
    const [deleting, setDeleting] = useState(false)
    const [naming, setNaming] = useState(false)

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

    // A search result opens the meeting at a moment (`?at=` seconds): once
    // the recording has loaded (a load starts it from 0) the player waits
    // there. A line (`?line=`, a transcript id) is scrolled into view by the
    // transcript itself, with audio or without. Each navigation that carries
    // them is a request, read as it arrives and then taken out of the URL:
    // the screen stays mounted for a hit inside the meeting already open, so
    // that hit (the same one again too) is a new request, and a tab switch,
    // which keeps the rest of the URL, is not.
    const location = useLocation()
    const [moment, setMoment] = useState(() => momentOf(params, location.key))
    const [seen, setSeen] = useState(location.key)
    if (seen !== location.key) {
        setSeen(location.key)
        const next = momentOf(params, location.key)
        if (next) setMoment(next)
    }
    const asked = params.has('at') || params.has('line')
    useEffect(() => {
        if (!asked) return
        setParams((current) => {
            const updated = new URLSearchParams(current)
            updated.delete('at')
            updated.delete('line')
            return updated
        }, {replace: true})
    }, [asked, setParams])
    const ready = playback.status === 'ready'
    useEffect(() => {
        if (ready && moment?.at != null) player.seek(moment.at)
    }, [ready, moment, player])

    const title = meeting.data?.title ?? ''
    const createdAt = parseDate(meeting.data?.created_at)
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
            toast.error(`Couldn’t copy the ${what}`, {description: errorMessage(error)})
        }
    }

    if (meeting.isError) {
        return (
            <Screen>
                <Centered role="alert">
                    <Heading>This meeting isn’t available</Heading>
                    <Muted>{errorMessage(meeting.error)}</Muted>
                    <Button size="sm" onClick={() => void navigate(paths.home)}>Back to meetings</Button>
                </Centered>
            </Screen>
        )
    }
    if (meeting.isPending) {
        return <Screen><Centered aria-busy="true"><Spinner delayed/></Centered></Screen>
    }

    return (
        <Screen bar={<PlayerBar
            player={player}
            {...playback}
            peaks={scrubbing ? peaks : null}
            rates={scrubbing ? SLOW_PLAYBACK_RATES : undefined}
            missingFolder={audio?.missingFolder}
        />}>
            <MeetingHeader
                title={title}
                createdAt={createdAt}
                durationSeconds={listed.data?.duration_seconds}
                folder={folder.data ?? null}
                folders={folders.data ?? []}
                hasRecordingFolder={!!meeting.data.folder_path}
                hasSummary={!!summaryText}
                canIdentifySpeakers={speakers.available && !speakers.running}
                canImprove={hasAudio && !!meeting.data.folder_path && !job && !speakers.running}
                onRename={() => setRenaming(true)}
                onMove={(folderId) => move.mutate(folderId)}
                onNewFolder={() => setNaming(true)}
                onCopyTranscript={() => void copy('transcript')}
                onCopySummary={() => void copy('summary')}
                onExport={() => openDialog({kind: 'export', meetingId})}
                onImprove={() => openDialog({kind: 'enhance', meetingId})}
                onOpenRecordingFolder={() => void openMeetingFolder(meetingId).catch((error: unknown) =>
                    toast.error('Couldn’t open the recording folder', {description: errorMessage(error)}))}
                onIdentifySpeakers={identifySpeakers}
                onDelete={() => setDeleting(true)}
            />
            <Status meetingId={meetingId}/>
            <Tabs label="Meeting views" options={TABS} value={tab} onChange={selectTab}>
                <Row>
                    <TabList/>
                    <Spacer/>
                    {tab === 'transcript' && speakers.available && (
                        <SpeakerCount lines={lines} running={speakers.running} onIdentify={identifySpeakers}/>
                    )}
                    {tab === 'summary' && !summaryBusy && summaryText && (
                        <Actions>
                            <IconButton label="Copy summary" onClick={() => void copy('summary')}>
                                <CopyIcon size={15} aria-hidden/>
                            </IconButton>
                            <IconButton label="Write the summary again" onClick={() => openDialog({kind: 'summary', meetingId})}>
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
                                        playback={playable ? player.clock : undefined}
                                        playing={playback.playing}
                                        revealLine={moment?.line}
                                        revealKey={moment?.key}
                                        onSeek={playback.status === 'ready' ? player.playFrom : undefined}
                                        clean={cleanLab && textMode === 'clean' ? cleanTranscriptText : undefined}
                                        tools={cleanLab && (
                                            <SegmentedControl label="Transcript text" options={TEXT_MODES} value={textMode} onChange={setTextMode}/>
                                        )}
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
        </Screen>
    )
}
