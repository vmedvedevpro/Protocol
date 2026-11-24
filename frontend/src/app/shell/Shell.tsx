import {Outlet, useMatches, useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {useNativeEvent} from '@/api/events'
import {TRAY_NAVIGATE_EVENT, TRAY_START_RECORDING_EVENT} from '@/api/tray'
import {platform} from '@/lib/platform'
import {useHotkey} from '../hotkeys'
import {paths} from '@/lib/paths'
import {FirstLaunchPlaceholder} from '../placeholder/Screens'
import {useModelDownloadSync} from '../useModelDownloadSync'
import {CrashReportSheet} from './CrashReportSheet'
import {useKeepOnTopStore, useKeepOnTopSync} from './keepOnTop'
import {useStartupPhase} from './startup'
import {StartupScreen} from './StartupScreen'
import {TitleBar} from './TitleBar'

/** What a shell route tells the title bar (`handle` in the route table). */
export interface ShellRouteHandle {
    /** Shows "Back to meetings". */
    back?: boolean
    /** The title Linux shows in the middle of the strip; Protocol by default. */
    title?: string
}

const Window = styled.div`
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: ${({theme}) => theme.colors.bg};
`

/**
 * The shell's own commands, mounted once first launch is done: no recording
 * may start before it, so the tray's Start and ⌘R are not heard until then.
 */
function ShellCommands() {
    const navigate = useNavigate()
    // #112 replaces the navigation with its start order; until then Record,
    // ⌘R and the tray open the recording screen.
    const startRecording = () => void navigate(paths.recording)

    useNativeEvent(TRAY_START_RECORDING_EVENT, startRecording)
    useHotkey({code: 'KeyR', mod: true}, startRecording, {level: 'app'})
    useHotkey({code: 'Comma', mod: true}, () => void navigate(paths.settings()), {level: 'app'})
    return null
}

/**
 * The main window: the title bar over the screen of the current route, once
 * startup has settled; until then "Checking setup…" or first launch. The
 * minibar window has its own route outside it.
 */
export function Shell() {
    const navigate = useNavigate()
    const matches = useMatches()
    const {phase, retry} = useStartupPhase()
    const ready = phase === 'ready'
    const handle: ShellRouteHandle = (ready ? matches.at(-1)?.handle : undefined) ?? {}
    const onTop = useKeepOnTopStore((state) => state.onTop)
    const setOnTop = useKeepOnTopStore((state) => state.setOnTop)
    useKeepOnTopSync()
    // In front of the startup gate: first launch starts the downloads.
    useModelDownloadSync()

    // The tray's Settings and update items, heard from the start: the route
    // shows once startup settles. The router keeps the page alive; a reload
    // would drop a meeting still being saved and the post-call jobs.
    useNativeEvent(TRAY_NAVIGATE_EVENT, (path) => void navigate(path))

    return (
        <Window>
            <TitleBar
                platform={platform}
                title={handle.title ?? 'Protocol'}
                onBack={handle.back ? () => void navigate(paths.home) : undefined}
                onTop={onTop}
                onTopChange={setOnTop}
            />
            {phase === 'ready' && (
                <>
                    <ShellCommands/>
                    <Outlet/>
                    <CrashReportSheet/>
                </>
            )}
            {phase === 'firstLaunch' && <FirstLaunchPlaceholder/>}
            {(phase === 'checking' || phase === 'slow' || phase === 'failed') && (
                <StartupScreen phase={phase} onRetry={retry}/>
            )}
        </Window>
    )
}
