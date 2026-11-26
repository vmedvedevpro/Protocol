import {useCallback, useEffect, useRef, useState} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import styled, {createGlobalStyle, useTheme} from 'styled-components'
import type {AudioSource} from '@/api/audio'
import {useSystemAudioWarning} from '@/components/ring/levelAdvice'
import {px} from '@/components/ui/styles'
import {useHotkey} from '@/lib/hotkeys'
import {platform} from '@/lib/platform'
import {
    pauseRecording,
    recordingKeys,
    recordingStateQuery,
    resumeRecording,
    setMicrophoneMuted,
    setSystemAudioMuted,
} from '../api/recording'
import {useNativeEvent} from '@/api/events'
import {
    exitCompactMode,
    MINIBAR_NOTICE_EVENT,
    MINIBAR_POINTER_ENTERED_EVENT,
    MINIBAR_POINTER_LEFT_EVENT,
    resizeMinibar,
    startWindowDragging,
    stopRecordingFromMinibar,
    takeMinibarNotice,
} from './api'
import {type MinibarPhase, MinibarPill} from './MinibarPill'

/**
 * How often the bar reads native's state: the timer, pause and mutes, its
 * own commands' and those made elsewhere (the tray, a shortcut), which reach
 * it within this. Half a second divides the timer's second, so each second
 * shows for a second.
 */
const POLL_MS = 500

/** A failed command is said in the status's place this long, as a toast stays. */
const FAILURE_MS = 5_000

// minibar.rs makes this window transparent so the pill's corners read as
// round. `:root` outranks GlobalStyle's `html` and `body` whatever order the
// two global styles are injected in.
const TransparentWindow = createGlobalStyle`
    :root,
    :root body {
        background: transparent;
    }
`

// The window follows the pill's width once it settles: hide what is outside
// it until then rather than scroll.
const Window = styled.div`
    display: flex;
    align-items: center;
    height: 100%;
    overflow: hidden;
`

/**
 * Fits the window to the pill's width. While the pill opens or closes its
 * width changes every frame, and each `resize_minibar` takes the minibar's
 * lifecycle lock, resizes the window and rebuilds its Windows region. So
 * the window follows only a settled width: one a whole frame went by
 * without changing (the observer reports at most once a frame, so a frame
 * without a report is a frame without a change). A pill that grows has the
 * window at its widest at once, so it never grows into the clip.
 */
function useFitWindow() {
    const theme = useTheme()
    const widest = px(theme.sizes.minibar.width)
    const sent = useRef<number | null>(null)
    const frame = useRef(0)
    useEffect(() => () => cancelAnimationFrame(frame.current), [])
    return useCallback((width: number) => {
        const send = (next: number) => {
            if (sent.current === next) return
            sent.current = next
            void resizeMinibar(next).catch((error: unknown) => console.error('Minibar: resizing failed', error))
        }
        cancelAnimationFrame(frame.current)
        if (sent.current === null) return send(width)
        if (width > sent.current) send(widest)
        frame.current = requestAnimationFrame(() => {
            frame.current = requestAnimationFrame(() => send(width))
        })
    }, [widest])
}

/**
 * The `minibar` window, which minibar.rs opens at `/minibar` while the main
 * window is hidden during a recording. Its JavaScript is its own: it follows
 * the recording from native state and events, and sends its commands to
 * native. Stop goes through `stop_recording_from_minibar`; native restores
 * the main window, which saves the meeting as after any Stop (#32).
 */
export function MinibarPage() {
    const queryClient = useQueryClient()
    const fitWindow = useFitWindow()
    const [stopping, setStopping] = useState(false)
    // An object, so the same failure twice restarts its timer.
    const [failure, setFailure] = useState<{ text: string } | null>(null)
    // Once Stop is pressed the timer holds at the take's length.
    const state = useQuery({...recordingStateQuery, refetchInterval: stopping ? false : POLL_MS})
    const native = state.data
    const phase: MinibarPhase = stopping || native?.is_recording === false ? 'finishing' : native?.is_paused ? 'paused' : 'recording'
    const muted = {mic: native?.is_microphone_muted ?? false, system: native?.is_system_audio_muted ?? false}
    const duration = native?.active_duration ?? native?.recording_duration ?? null
    const warning = useSystemAudioWarning(phase === 'recording' && !muted.system)

    const refresh = () => void queryClient.invalidateQueries({queryKey: recordingKeys.state()})

    useEffect(() => {
        if (!failure) return
        const clear = setTimeout(() => setFailure(null), FAILURE_MS)
        return () => clearTimeout(clear)
    }, [failure])

    async function run(action: () => Promise<unknown>, failed: string) {
        try {
            await action()
            setFailure(null)
        } catch (error) {
            console.error(`Minibar: ${failed}`, error)
            setFailure({text: failed})
        }
        refresh()
    }

    const togglePause = () => {
        if (phase === 'finishing') return
        const pausing = phase === 'recording'
        void run(pausing ? pauseRecording : resumeRecording, pausing ? 'Could not pause' : 'Could not resume')
    }

    const toggleMute = (source: AudioSource) => {
        const next = !muted[source]
        void run(() => (source === 'mic' ? setMicrophoneMuted(next) : setSystemAudioMuted(next)), next ? 'Could not mute' : 'Could not unmute')
    }

    const stop = async () => {
        if (phase === 'finishing') return
        setStopping(true)
        try {
            // Native hides this window as the stop begins and closes it after.
            // From there the stop cannot fail: what goes wrong (the audio file)
            // reaches the main window with `recording-stop-complete`, which
            // says so in a toast (save.ts). A rejection comes before native
            // hid the bar, so the bar is still where the user can read it.
            await stopRecordingFromMinibar()
        } catch (error) {
            console.error('Minibar: stop failed', error)
            setStopping(false)
            setFailure({text: 'Could not stop'})
        }
    }

    // The window has these only while it is focused: Space pauses, as on
    // the recording screen; the stop shortcut stops, as in the main window.
    // On Linux native code says where the pointer is (api.ts).
    const [pointerOver, setPointerOver] = useState(false)
    useNativeEvent(MINIBAR_POINTER_LEFT_EVENT, () => setPointerOver(false), {target: 'minibar'})
    useNativeEvent(MINIBAR_POINTER_ENTERED_EVENT, () => setPointerOver(true), {target: 'minibar'})

    // Native says once a run when the bar cannot stay on top (Linux): in the
    // status's place, as a failed command is. Read again once listening, in
    // case the word came before.
    const showNotice = () => {
        if (platform !== 'linux') return
        takeMinibarNotice().then(
            (notice) => notice && setFailure({text: notice}),
            (error: unknown) => console.error('Minibar: the notice could not be read', error),
        )
    }
    useNativeEvent(MINIBAR_NOTICE_EVENT, showNotice, {target: 'minibar', onListening: showNotice})

    useHotkey({code: 'Space'}, togglePause)
    useHotkey({code: 'KeyR', mod: true}, () => void stop())

    return (
        <Window>
            <TransparentWindow/>
            {(native || state.isError) && (
                <MinibarPill
                    phase={phase}
                    seconds={duration === null ? null : Math.floor(duration)}
                    muted={muted}
                    warning={warning}
                    failure={failure?.text ?? null}
                    stopKeys={platform === 'macos' ? 'Meta+R' : 'Control+R'}
                    onTogglePause={togglePause}
                    onToggleMute={toggleMute}
                    onStop={() => void stop()}
                    onBackToWindow={() => void run(exitCompactMode, 'Could not open')}
                    onWidthChange={fitWindow}
                    pointerOver={platform === 'linux' ? pointerOver : undefined}
                    onDragStart={() => void startWindowDragging().catch((error: unknown) => console.error('Minibar: dragging failed', error))}
                />
            )}
        </Window>
    )
}
