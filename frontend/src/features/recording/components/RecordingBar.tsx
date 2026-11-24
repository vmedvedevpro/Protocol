import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {type RecordingPhase, useRecordingPhase} from '@/api/recordingPhase'
import {Ring} from '@/components/ring/Ring'
import {Button} from '@/components/ui/Button'
import {Kbd} from '@/components/ui/Kbd'
import {paths} from '@/app/paths'
import {DockedBar} from '@/app/shell/DockedBar'
import {formatShortcut} from '@/lib/platform'

const Status = styled.span`
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

const PHASE_TEXT: Record<Exclude<RecordingPhase, 'idle'>, string> = {
    starting: 'Starting…',
    recording: 'Recording',
    paused: 'Paused',
    finishing: 'Finishing…',
}

interface RecordingBarProps {
    /**
     * Shows the bar while nothing records (Record), on the screen whose
     * design docks it idle: Home. While a recording runs or finishes it shows
     * on every screen regardless.
     */
    idle?: boolean
}

/**
 * The recording's bar at the bottom of the window (`DockedBar` lays it out).
 * `Screen` renders it on every screen of the main window, above the screen's
 * own bar.
 */
export function RecordingBar({idle = false}: RecordingBarProps) {
    const navigate = useNavigate()
    const phase = useRecordingPhase()
    const record = formatShortcut('R')

    if (phase === 'idle') {
        if (!idle) return null
        return (
            <DockedBar
                label="Record"
                ring={<Ring mode="idle" size={56}/>}
                action={(
                    <Button variant="filled" trailing={<Kbd tone="fill">{record}</Kbd>} onClick={() => void navigate(paths.recording)}>
                        Record
                    </Button>
                )}
            >
                <Status>Ready to record</Status>
            </DockedBar>
        )
    }

    return (
        <DockedBar label="Recording" ring={<Ring mode={phase === 'recording' ? 'rec' : 'paused'} size={56}/>}>
            <Status>{PHASE_TEXT[phase]}</Status>
        </DockedBar>
    )
}
