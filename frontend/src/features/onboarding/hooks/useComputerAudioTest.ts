import {useEffect, useState} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import {type LevelFeed, useAudioLevel} from '@/api/audio'
import {permissionKeys, systemAudioPermissionQuery, systemAudioProbeQuery} from '@/api/permissions'
import type {Platform} from '@/lib/platform'

/**
 * How long the test listens for computer audio: as long as macOS's probe
 * (`trigger_system_audio_permission_command`, audio/permissions.rs), so the
 * test takes the same time everywhere.
 */
export const LISTEN_MS = 5000

export type ComputerAudioTest =
    | {state: 'idle' | 'listening' | 'heard'}
    /** `denied`: macOS refuses Audio Capture, which only System Settings changes. */
    | {state: 'silent', denied: boolean}

/**
 * "Test computer audio". macOS runs the Audio Capture probe, which asks for
 * the permission the first time and answers whether it heard audio. Windows
 * and Linux need no permission: the ring follows the output device
 * (`feed`, previewed with the microphone) until it hears something or
 * `LISTEN_MS` pass; a silent loopback reads digital silence, below the
 * meters' floor, so any level above 0 is sound.
 */
export function useComputerAudioTest(platform: Platform, output: LevelFeed): {test: ComputerAudioTest, start: () => void, feed: LevelFeed | null} {
    const queryClient = useQueryClient()
    const probe = useQuery(systemAudioProbeQuery)
    const permission = useQuery({...systemAudioPermissionQuery, enabled: platform === 'macos'})
    const [listening, setListening] = useState(false)
    const [heard, setHeard] = useState<boolean | null>(null)

    const listen = platform !== 'macos' && listening
    // The first sound ends the test; the subscription ends with it.
    useAudioLevel(listen ? output : null, (level) => {
        if (level <= 0) return
        setListening(false)
        setHeard(true)
    })
    useEffect(() => {
        if (!listen) return
        const timeout = window.setTimeout(() => {
            setListening(false)
            setHeard(false)
        }, LISTEN_MS)
        return () => window.clearTimeout(timeout)
    }, [listen])

    const start = () => {
        if (platform !== 'macos') {
            setHeard(null)
            setListening(true)
            return
        }
        // The probe may have changed the Audio Capture record.
        void probe.refetch().then(() => queryClient.invalidateQueries({queryKey: permissionKeys.systemAudio()}))
    }

    let test: ComputerAudioTest = {state: 'idle'}
    if (platform === 'macos') {
        if (probe.isFetching) test = {state: 'listening'}
        else if (probe.data === true) test = {state: 'heard'}
        else if (probe.data === false || probe.isError) test = {state: 'silent', denied: permission.data === 'denied'}
    } else if (listening) {
        test = {state: 'listening'}
    } else if (heard !== null) {
        test = heard ? {state: 'heard'} : {state: 'silent', denied: false}
    }
    return {test, start, feed: listen ? output : null}
}
