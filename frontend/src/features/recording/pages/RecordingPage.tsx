import {useMemo, useState} from 'react'
import {SparkleIcon} from '@phosphor-icons/react'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {useUserName} from '@/api/preferences'
import {NotesEditor} from '@/components/editor/NotesEditor'
import {TranscriptList} from '@/components/transcript/TranscriptList'
import {Screen} from '@/components/screen/Screen'
import {Button} from '@/components/ui/Button'
import {TabList, TabPanels, Tabs} from '@/components/ui/SegmentedControl'
import {Spinner} from '@/components/ui/Spinner'
import {StatusLine} from '@/components/ui/StatusLine'
import {toast} from '@/components/ui/toastStore'
import {useHotkey} from '@/lib/hotkeys'
import {summarizeSoFar} from '../api/assistant'
import {toTranscriptLine} from '../api/transcript'
import {RecordingHeader} from '../components/RecordingHeader'
import {setLiveNotes} from '../store/liveNotes'
import {renameSpeaker, togglePause} from '../store/runtime'
import {useSessionStore, voicesOf} from '../store/session'

export type RecordingTab = 'notes' | 'transcript' | 'summary'

const TABS = [
    {value: 'notes', label: 'Notes'},
    {value: 'transcript', label: 'Transcript'},
    {value: 'summary', label: 'Summary'},
] as const

const Bar = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    padding: 0 ${({theme}) => theme.space[4]} ${({theme}) => theme.space[2]};
`

const Meta = styled.span`
    margin-inline-start: auto;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Body = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    border-top: 1px solid ${({theme}) => theme.colors.border};
`

const Panel = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    padding: ${({theme}) => theme.space[3]} ${({theme}) => theme.space[4]};
`

// The transcript scrolls and pads itself, as on the meeting screen.
const Column = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
`

// A wait for the first line: the spinner shows it is still listening.
const Listening = styled.span`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

const Footnote = styled.p`
    flex: none;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[4]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Empty = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${({theme}) => theme.space[1.5]};
    padding: ${({theme}) => theme.space[4]};
    text-align: center;
`

const EmptyTitle = styled.h2`
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

const EmptyText = styled.p`
    max-width: 36ch;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Answer = styled.section`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2]};
`

/** The editor of one recording's notes, mounted from the session's latest copy. */
function LiveNotesEditor({editable}: { editable: boolean }) {
    // Read once per mount: the editor owns the text while it is mounted, and
    // the session holds every edit, so a remount never shows an older copy.
    const [initial] = useState(() => useSessionStore.getState().notes)

    return (
        <NotesEditor
            initialBlocks={initial?.json}
            initialMarkdown={initial?.markdown}
            label="Notes"
            placeholder="Type notes as the meeting goes…"
            editable={editable}
            onChange={setLiveNotes}
        />
    )
}

/** Notes typed during the recording, saved on the meeting when it stops. */
function NotesPanel() {
    const recoveryId = useSessionStore((state) => state.recoveryId)
    const phase = useSessionStore((state) => state.phase)

    return (
        <>
            <Panel>
                {/* From Stop on, the notes saved are the ones typed until then. */}
                <LiveNotesEditor key={recoveryId ?? 'idle'} editable={phase === 'recording' || phase === 'paused'}/>
            </Panel>
            <Footnote>Notes merge with the transcript when you stop.</Footnote>
        </>
    )
}

function TranscriptPanel() {
    const lines = useSessionStore((state) => state.lines)
    const userName = useUserName()
    const shown = useMemo(() => lines.map(toTranscriptLine), [lines])

    return (
        <Column>
            <TranscriptList
                lines={shown}
                label="Live transcript"
                live
                userName={userName || undefined}
                onRenameSpeaker={renameSpeaker}
                empty={(
                    <Empty>
                        <EmptyTitle><Listening><Spinner/>Listening…</Listening></EmptyTitle>
                        <EmptyText>Lines appear here as people speak.</EmptyText>
                    </Empty>
                )}
            />
        </Column>
    )
}

/**
 * The summary is written after Stop; "Summarize so far" asks the summary
 * model for one of the transcript until now, which is not saved.
 */
function SummaryPanel() {
    const lines = useSessionStore((state) => state.lines)
    const [answer, setAnswer] = useState<string | null>(null)
    const [pending, setPending] = useState(false)

    const summarize = async () => {
        const {notes} = useSessionStore.getState()
        setPending(true)
        try {
            setAnswer(await summarizeSoFar(lines, notes?.markdown ?? null))
        } catch (error) {
            toast.error('Could not summarize', {description: errorMessage(error)})
        } finally {
            setPending(false)
        }
    }

    const button = (
        <Button variant={answer ? 'secondary' : 'filled'} size="sm" pending={pending} disabled={lines.length === 0} onClick={() => void summarize()}>
            <SparkleIcon size={13}/>
            {answer ? 'Summarize again' : 'Summarize so far'}
        </Button>
    )

    if (!answer) {
        return (
            <Panel>
                <Empty>
                    <EmptyTitle>Summary is written when you stop</EmptyTitle>
                    <EmptyText>It’s written once the recording ends. Your notes steer what it focuses on.</EmptyText>
                    {button}
                </Empty>
            </Panel>
        )
    }
    return (
        <Panel>
            <Answer aria-label="Summary so far">
                {/* Read-only Markdown in the notes' typography; remounted for each answer. */}
                <NotesEditor key={answer} initialMarkdown={answer} editable={false} label="Summary so far"/>
                <div>{button}</div>
            </Answer>
        </Panel>
    )
}

const voicesLabel = (count: number) => `${count} ${count === 1 ? 'voice' : 'voices'}`

/**
 * The recording screen (`/recording`): the header, then Notes, Transcript
 * and Summary over one area. The recording bar under it (the shell's
 * footer) holds the controls. With no recording it says how to start one;
 * from Stop until the meeting opens, what the save is doing.
 */
export function RecordingPage() {
    const phase = useSessionStore((state) => state.phase)
    const step = useSessionStore((state) => state.step)
    const voices = useSessionStore((state) => voicesOf(state.lines).length)
    const [tab, setTab] = useState<RecordingTab>('notes')
    const live = phase === 'recording' || phase === 'paused'

    // Space is this screen's: it never pauses a recording the user cannot see.
    useHotkey({code: 'Space'}, () => void togglePause(), {enabled: live})
    useHotkey({code: 'Digit1', mod: true}, () => setTab('notes'), {enabled: live})
    useHotkey({code: 'Digit2', mod: true}, () => setTab('transcript'), {enabled: live})
    useHotkey({code: 'Digit3', mod: true}, () => setTab('summary'), {enabled: live})

    if (phase === 'idle' || phase === 'starting') {
        return (
            <Screen recordBar>
                <RecordingHeader/>
                <Body>
                    <Empty>
                        {phase === 'starting' ? (
                            <StatusLine status={{key: step ?? 'starting', text: step ?? 'Starting…', busy: true}}/>
                        ) : (
                            <>
                                <EmptyTitle>Not recording</EmptyTitle>
                                <EmptyText>Press Record below to start. Notes, the live transcript and the summary show here.</EmptyText>
                            </>
                        )}
                    </Empty>
                </Body>
            </Screen>
        )
    }

    return (
        <Screen>
            <RecordingHeader/>
            <Tabs label="Recording views" options={TABS} value={tab} onChange={setTab}>
                <Bar>
                    <TabList/>
                    {/* While finishing, the bar alone says what the save is doing. */}
                    <Meta>
                        {phase === 'finishing' ? null
                            : tab === 'notes' ? 'Autosaved'
                                : tab === 'transcript' && voices > 0 ? voicesLabel(voices) : null}
                    </Meta>
                </Bar>
                <Body>
                    <TabPanels<RecordingTab>>
                        {(shown) => shown === 'notes' ? <NotesPanel/> : shown === 'transcript' ? <TranscriptPanel/> : <SummaryPanel/>}
                    </TabPanels>
                </Body>
            </Tabs>
        </Screen>
    )
}
