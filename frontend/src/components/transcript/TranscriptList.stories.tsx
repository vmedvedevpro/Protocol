import {useEffect, useMemo, useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {sampleTranscript} from '@/mocks/meetings'
import {UserIcon} from '@phosphor-icons/react'
import {type PlaybackClock, type SpeakerTarget, TranscriptList} from './TranscriptList'
import {lineFromSegment, type TranscriptLine} from './turns'

// The meeting screen's panel: the list scrolls inside it.
const Frame = styled.div`
    display: flex;
    flex-direction: column;
    width: ${({theme}) => theme.sizes.window.width};
    height: 480px;
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.lg};
    background: ${({theme}) => theme.colors.bg};
    overflow: hidden;
`

const Note = styled.p`
    margin: 0 ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[1.5]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

/** A clock that runs one second of playback per 250 ms, from `from`. */
function useStoryClock(from: number): { clock: PlaybackClock, seek: (seconds: number) => void } {
    const [state] = useState(() => {
        const listeners = new Set<(seconds: number) => void>()
        let position = from
        return {
            listeners,
            clock: {
                subscribe: (listener: (seconds: number) => void) => {
                    listeners.add(listener)
                    listener(position)
                    return () => listeners.delete(listener)
                },
            },
            seek: (seconds: number) => {
                position = seconds
                listeners.forEach((listener) => listener(position))
            },
            tick: () => {
                position += 4
                listeners.forEach((listener) => listener(position))
            },
        }
    })
    useEffect(() => {
        const timer = setInterval(state.tick, 250)
        return () => clearInterval(timer)
    }, [state])
    return {clock: state.clock, seek: state.seek}
}

// The design's meeting: the turn being played is lit, a time plays from
// there, and an unnamed voice can be named in place.
function Saved() {
    const [lines, setLines] = useState(() => sampleTranscript('meeting-untitled').map(lineFromSegment))
    const {clock, seek} = useStoryClock(4)
    const rename = async (from: string, to: string) => {
        setLines((current) => current.map((line) => (line.speaker === from ? {...line, speaker: to} : line)))
    }
    return (
        <Frame>
            <TranscriptList label="Transcript" lines={lines} onSeek={seek} onRenameSpeaker={rename} playback={clock} followPlayback/>
        </Frame>
    )
}

// A voice's menu: its contact (#118) and Who said this (#119) from the
// caller, then Rename speaker; a voice with only the rename names in place.
const storyActions = (target: SpeakerTarget) =>
    target.speaker === 'Tom Becker'
        ? [{id: 'open', label: 'Open Tom Becker', icon: <UserIcon/>, onSelect: () => undefined}]
        : []

function WithMenus() {
    const [lines, setLines] = useState(() => sampleTranscript('meeting-acme-kickoff').map(lineFromSegment))
    const rename = async (from: string, to: string) => {
        setLines((current) => current.map((line) => (line.speaker === from ? {...line, speaker: to} : line)))
    }
    return (
        <Frame>
            <TranscriptList label="Transcript" lines={lines} onRenameSpeaker={rename} speakerActions={storyActions}/>
        </Frame>
    )
}

const LIVE_TEXT = [
    'So the first thing on the list is the rollout date.',
    'Right, and Legal still wants the retention statement first.',
    'I can draft it today.',
    'Then we can send it with the pilot config on Friday.',
    'Does anyone need more time?',
]

// #112's live transcript: a line arrives every 1.2 s and the view follows
// the end; scroll up and it stays put, with Latest to go back down.
function Live() {
    const [lines, setLines] = useState<TranscriptLine[]>([])
    useEffect(() => {
        let index = 0
        const timer = setInterval(() => {
            const start = index * 6
            setLines((current) => [...current, {
                id: `live-${index}`,
                text: LIVE_TEXT[index % LIVE_TEXT.length],
                start,
                end: start + 4,
                speaker: index % 3 === 0 ? 'You' : 'Speaker 1',
            }])
            index += 1
        }, 1200)
        return () => clearInterval(timer)
    }, [])
    return (
        <Frame>
            <TranscriptList
                label="Live transcript"
                live
                lines={lines}
                empty={<Note>Lines appear here as people talk.</Note>}
            />
        </Frame>
    )
}

// Three hours of speech: rows off screen are skipped, so scrolling and the
// highlight stay cheap.
function Long() {
    const lines = useMemo(() => Array.from({length: 3000}, (_, index): TranscriptLine => ({
        id: `long-${index}`,
        text: LIVE_TEXT[index % LIVE_TEXT.length],
        start: index * 3.6,
        end: index * 3.6 + 3,
        speaker: index % 2 === 0 ? 'You' : `Speaker ${(index % 3) + 1}`,
    })), [])
    const {clock, seek} = useStoryClock(3600)
    return (
        <Frame>
            <TranscriptList label="Transcript" lines={lines} onSeek={seek} playback={clock} followPlayback/>
        </Frame>
    )
}

const meta = {
    title: 'Transcript/TranscriptList',
    component: Saved,
} satisfies Meta<typeof Saved>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

export const LiveTranscript: Story = {render: () => <Live/>}

export const ThreeHours: Story = {render: () => <Long/>}

export const SpeakerMenu: Story = {render: () => <WithMenus/>}
