import {Outlet, useMatches, useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {useNativeEvent} from '@/api/events'
import {useModelDownloadSync} from '@/api/modelDownloadSync'
import {useSpeechConfigSync} from '@/api/speech'
import {TRAY_NAVIGATE_EVENT, TRAY_START_RECORDING_EVENT} from '@/api/tray'
import {DownloadLineContext} from '@/components/screen/downloadLine'
import {RecordBarContext} from '@/components/screen/recordBar'
import {DialogHost} from '@/features/dialogs/DialogHost'
import {UpdateToasts} from '@/features/meetings/home/UpdateToasts'
import {FirstLaunch} from '@/features/onboarding/pages/FirstLaunch'
import {RecordingBar} from '@/features/recording/components/RecordingBar'
import {RecordingRuntime} from '@/features/recording/components/RecordingRuntime'
import {toggleRecording} from '@/features/recording/store/runtime'
import {startRecording} from '@/features/recording/store/start'
import {useHotkey} from '@/lib/hotkeys'
import {platform} from '@/lib/platform'
import {paths} from '@/lib/paths'
import {CrashReportSheet} from './CrashReportSheet'
import {GlobalSearch} from './GlobalSearch'
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

// The bar every screen docks (Screen): the recording's.
const renderRecordBar = (idle: boolean) => <RecordingBar idle={idle}/>

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
 * ⌘R starts a recording, or stops the one that runs; the recording's runtime
 * hears native from here on every screen.
 */
function ShellCommands() {
    const navigate = useNavigate()

    // The tray asks only while nothing records; its Stop is native's.
    useNativeEvent(TRAY_START_RECORDING_EVENT, () => void startRecording())
    useHotkey({code: 'KeyR', mod: true}, toggleRecording, {level: 'app'})
    useHotkey({code: 'Comma', mod: true}, () => void navigate(paths.settings()), {level: 'app'})
    // Search registers ⌘K and runs the recording's commands too.
    return <><RecordingRuntime/><GlobalSearch/></>
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
    // In front of the startup gate: first launch starts the downloads, and
    // native activates Whisper after its download.
    useModelDownloadSync()
    useSpeechConfigSync()

    // The tray's Settings and update items, heard from the start: the route
    // shows once startup settles. The router keeps the page alive; a reload
    // would drop a meeting still being saved and the post-call jobs.
    useNativeEvent(TRAY_NAVIGATE_EVENT, (path) => void navigate(path))

    return (
        <RecordBarContext value={renderRecordBar}>
            <Window>
                <TitleBar
                    platform={platform}
                    title={phase === 'firstLaunch' ? 'Welcome' : handle.title ?? 'Protocol'}
                    onBack={handle.back ? () => void navigate(paths.home) : undefined}
                    onTop={onTop}
                    onTopChange={setOnTop}
                />
                {phase === 'ready' && (
                    <DownloadLineContext value>
                        <ShellCommands/>
                        <Outlet/>
                        <CrashReportSheet/>
                        <UpdateToasts/>
                        <DialogHost/>
                    </DownloadLineContext>
                )}
                {phase === 'firstLaunch' && <FirstLaunch/>}
                {phase !== 'ready' && phase !== 'firstLaunch' && <StartupScreen phase={phase} onRetry={retry}/>}
            </Window>
        </RecordBarContext>
    )
}
