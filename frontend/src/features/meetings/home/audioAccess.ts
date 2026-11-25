import {useQuery} from '@tanstack/react-query'
import {audioDevicesQuery} from '@/api/devices'
import {systemAudioAllowed, systemAudioPermissionQuery, systemAudioProbeQuery} from '@/api/permissions'
import {platform as currentPlatform, type Platform} from '@/lib/platform'

/** What Protocol can hear, as far as devices and permissions go; null until known. */
export interface AudioAccess {
    microphone: boolean
    computerAudio: boolean
}

/**
 * Whether Protocol can hear the microphone and the computer audio. A
 * microphone counts when the system lists an input (it lists none while it
 * refuses access); computer audio needs an output to record by loopback and,
 * on macOS, Audio Capture, granted on record or heard by this session's
 * probe (`systemAudioAllowed`).
 */
export function useAudioAccess(on: Platform = currentPlatform): AudioAccess | null {
    const devices = useQuery(audioDevicesQuery)
    const permission = useQuery({...systemAudioPermissionQuery, enabled: on === 'macos'})
    const probe = useQuery(systemAudioProbeQuery)
    if (!devices.data || (on === 'macos' && permission.isPending)) return null
    const microphone = devices.data.some((device) => device.device_type === 'Input')
    const output = devices.data.some((device) => device.device_type === 'Output')
    const allowed = on !== 'macos' || systemAudioAllowed(permission.data ?? 'unknown', probe.data)
    return {microphone, computerAudio: output && allowed}
}

/** Whether Home shows the banner: something is missing, on a platform that asks. */
export const needsPermissionBanner = (access: AudioAccess | null, on: Platform = currentPlatform) =>
    !!access && on !== 'linux' && (!access.microphone || !access.computerAudio)
