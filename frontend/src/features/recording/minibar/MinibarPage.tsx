import {useEffect, useState} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import styled, {createGlobalStyle} from 'styled-components'
import type {AudioSource} from '@/api/audio'
import {useNativeEvent} from '@/api/events'
import {useSystemAudioWarning} from '@/components/ring/levelAdvice'
import {useHotkey} from '@/lib/hotkeys'
import {platform} from '@/lib/platform'
import {
    MICROPHONE_MUTE_CHANGED_EVENT,
    pauseRecording,
    RECORDING_PAUSED_EVENT,
    RECORDING_RESUMED_EVENT,
    recordingKeys,
    recordingStateQuery,
    resumeRecording,
    setMicrophoneMuted,
    setSystemAudioMuted,
    SYSTEM_AUDIO_MUTE_CHANGED_EVENT,
} from '../api/recording'
import {exitCompactMode, startWindowDragging, stopRecordingFromMinibar} from './api'
import {type MinibarPhase, MinibarPill} from './MinibarPill'

/**
 * How often the bar reads native's state: the timer, pause and mutes. The
 * events below bring a change at once; the poll keeps the timer going and
 * catches what an event missed (PARITY.md, `get_recording_state`). Half a
 * second divides the timer's second, so each second shows for a second.
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

const Window = styled.div`
    display: flex;
    align-items: center;
    height: 100%;
`

/**
 * The `minibar` window, which minibar.rs opens at `/minibar` while the main
 * window is hidden during a recording. Its JavaScript is its own: it follows
 * the recording from native state and events, and sends its commands to
 * native. Stop goes through `stop_recording_from_minibar`; native restores
 * the main window, which saves the meeting as after any Stop (#32).
 */
export function MinibarPage() {
    const queryClient = useQueryClient()
    const [stopping, setStopping] = useState(false)
    const [failure, setFailure] = useState<{ text: string } | null>(null)
    // Once Stop is pressed the timer holds at the take's length.
    const state = useQuery({...recordingStateQuery, refetchInterval: stopping ? false : POLL_MS})
    const native = state.data
    const phase: MinibarPhase = stopping || native?.is_recording === false ? 'finishing' : native?.is_paused ? 'paused' : 'recording'
    const muted = {mic: native?.is_microphone_muted ?? false, system: native?.is_system_audio_muted ?? false}
    const duration = native?.active_duration ?? native?.recording_duration ?? null
    const warning = useSystemAudioWarning(phase === 'recording' && !muted.system)

    const refresh = () => void queryClient.invalidateQueries({queryKey: recordingKeys.state()})
    useNativeEvent(RECORDING_PAUSED_EVENT, refresh)
    useNativeEvent(RECORDING_RESUMED_EVENT, refresh)
    useNativeEvent(MICROPHONE_MUTE_CHANGED_EVENT, refresh)
    useNativeEvent(SYSTEM_AUDIO_MUTE_CHANGED_EVENT, refresh)

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
            await stopRecordingFromMinibar()
        } catch (error) {
            console.error('Minibar: stop failed', error)
            setStopping(false)
            setFailure({text: 'Could not stop'})
        }
    }

    // The window has these only while it is focused: Space pauses, as on
    // the recording screen; the stop shortcut stops, as in the main window.
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
                    onDragStart={() => void startWindowDragging().catch((error: unknown) => console.error('Minibar: dragging failed', error))}
                />
            )}
        </Window>
    )
}
