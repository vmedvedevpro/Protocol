import {useQuery} from '@tanstack/react-query'
import {CaretDownIcon, StopIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {recordingPreferencesQuery} from '@/api/devices'
import {useSystemAudioWarning} from '@/components/ring/levelAdvice'
import {Ring} from '@/components/ring/Ring'
import {SourceMeter} from '@/components/ring/SourceMeter'
import {Button, IconButton} from '@/components/ui/Button'
import {Kbd} from '@/components/ui/Kbd'
import {StatusLine} from '@/components/ui/StatusLine'
import {focusRing} from '@/components/ui/styles'
import {Tooltip} from '@/components/ui/Tooltip'
import {paths} from '@/lib/paths'
import {formatShortcut} from '@/lib/platform'
import {tween} from '@/styles/motion'
import {inputsSummary} from '../lib/inputs'
import {setSourceMuted, togglePause} from '../store/runtime'
import {useSessionStore} from '../store/session'
import {startRecording} from '../store/start'
import {stopRecording} from '../store/save'
import {DockedBar} from './DockedBar'
import {InputsMenu} from './InputsMenu'
import {Timer} from './Timer'

const RING_SIZE = 56

const Status = styled.span`
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

const Top = styled.span`
    display: flex;
    align-items: baseline;
    gap: ${({theme}) => theme.space[2]};
`

const Paused = styled(m.span)`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Sources = styled.span`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    margin-top: ${({theme}) => theme.space[0.5]};
`

// The second line of the idle bar: "Headset + all apps ▾", which opens Change inputs.
const Inputs = styled.button`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    max-width: 100%;
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: none;
    color: ${({theme}) => theme.colors.muted};
    font: inherit;
    ${({theme}) => theme.text.small};
    cursor: pointer;

    &:hover {
        color: ${({theme}) => theme.colors.text};
    }

    ${focusRing};

    > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
`

// The ring is the pause button while recording; idle it only shows.
const RingButton = styled.button`
    display: flex;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    cursor: pointer;

    ${focusRing};
`

const Muted = styled.span`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

interface RecordingBarProps {
    /**
     * Shows the bar while nothing records (Record), on the screens whose
     * design docks it idle: Home and the recording screen. While a recording
     * starts, runs or is saved it shows on every screen regardless.
     */
    idle?: boolean
}

/**
 * The recording's bar at the bottom of the window (`DockedBar` lays it out),
 * on every screen of the main window above the screen's own bar.
 *
 * - Idle: the grey ring, "Ready to record" over the inputs, Record.
 * - Starting: what the start is doing, Record pending.
 * - Recording or paused: the ring pauses and resumes; the timer; the
 *   microphone and computer audio with their levels (a click mutes); Change
 *   inputs; Stop.
 * - Finishing: what the save is doing, until the meeting opens.
 */
export function RecordingBar({idle = false}: RecordingBarProps) {
    const navigate = useNavigate()
    const phase = useSessionStore((state) => state.phase)
    const step = useSessionStore((state) => state.step)
    const muted = useSessionStore((state) => state.muted)
    const unavailable = useSessionStore((state) => state.unavailable)
    const preferences = useQuery(recordingPreferencesQuery)
    const warning = useSystemAudioWarning(phase === 'recording' && !muted.system)
    const shortcut = formatShortcut('R')
    const openSettings = () => void navigate(paths.settings('recording'))

    if (phase === 'idle' || phase === 'starting') {
        if (phase === 'idle' && !idle) return null
        const starting = phase === 'starting'
        return (
            <DockedBar
                label="Record"
                ring={<Ring mode="idle" size={RING_SIZE}/>}
                action={(
                    <Button
                        variant="filled"
                        pending={starting}
                        disabled={!!unavailable}
                        trailing={<Kbd tone="fill">{shortcut}</Kbd>}
                        onClick={() => void startRecording()}
                    >
                        Record
                    </Button>
                )}
            >
                {starting ? (
                    <StatusLine status={{key: step ?? 'starting', text: step ?? 'Starting…', busy: true}}/>
                ) : unavailable ? (
                    <>
                        <Status>Recording is unavailable</Status>
                        <Muted>{unavailable}</Muted>
                    </>
                ) : (
                    <>
                        <Status>Ready to record</Status>
                        <InputsMenu
                            onOpenSettings={openSettings}
                            trigger={(
                                <Inputs type="button" aria-label={`Inputs: ${inputsSummary(preferences.data)}. Change`}>
                                    <span>{inputsSummary(preferences.data)}</span>
                                    <CaretDownIcon size={11} aria-hidden="true"/>
                                </Inputs>
                            )}
                        />
                    </>
                )}
            </DockedBar>
        )
    }

    if (phase === 'finishing') {
        return (
            <DockedBar label="Recording" ring={<Ring mode="paused" size={RING_SIZE}/>}>
                <StatusLine status={{key: step ?? 'finishing', text: step ?? 'Finishing…', busy: true}}/>
            </DockedBar>
        )
    }

    const paused = phase === 'paused'
    return (
        <DockedBar
            label="Recording"
            ring={(
                <Tooltip content={paused ? 'Resume' : 'Pause'} shortcut="Space">
                    <RingButton
                        type="button"
                        aria-label={paused ? 'Resume recording' : 'Pause recording'}
                        onClick={() => void togglePause()}
                    >
                        <Ring mode={paused ? 'paused' : 'rec'} size={RING_SIZE} level={{kind: 'recording', source: 'both'}}/>
                    </RingButton>
                </Tooltip>
            )}
            action={(
                <Button trailing={<Kbd>{shortcut}</Kbd>} onClick={() => void stopRecording()}>
                    <StopIcon size={12} weight="fill"/>
                    Stop
                </Button>
            )}
        >
            <Top>
                <Timer/>
                <AnimatePresence initial={false}>
                    {paused && (
                        <Paused key="paused" initial={{opacity: 0, y: 4}} animate={{opacity: 1, y: 0}} exit={{opacity: 0, y: -4}} transition={tween('fast')}>
                            Paused
                        </Paused>
                    )}
                </AnimatePresence>
            </Top>
            <Sources>
                <SourceMeter
                    source="mic"
                    muted={muted.mic}
                    level={paused ? null : {kind: 'recording', source: 'mic'}}
                    onToggle={() => void setSourceMuted('mic', !muted.mic)}
                />
                <SourceMeter
                    source="system"
                    muted={muted.system}
                    level={paused ? null : {kind: 'recording', source: 'system'}}
                    warning={warning}
                    onToggle={() => void setSourceMuted('system', !muted.system)}
                />
                <InputsMenu
                    onOpenSettings={openSettings}
                    trigger={(
                        <IconButton label="Change inputs" size="sm">
                            <CaretDownIcon size={13}/>
                        </IconButton>
                    )}
                />
            </Sources>
        </DockedBar>
    )
}
