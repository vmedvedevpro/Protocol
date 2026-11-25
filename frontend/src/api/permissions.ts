/**
 * Whether Protocol may hear the microphone and the computer audio, and the
 * requests that make the system ask (audio/permissions.rs,
 * audio/devices/discovery.rs, utils.rs). First launch asks during its
 * microphone check; the Home banner (#113) explains what is missing and
 * asks again.
 *
 * There is no microphone status to read: a microphone is usable when the
 * device list (`get_audio_devices`, src/api/devices.ts) has an input, since
 * the system lists none while it refuses access. Computer audio needs a
 * permission only on macOS (Audio Capture), whose record can lag behind a
 * grant until the app restarts; a probe that hears audio in this session
 * proves the grant meanwhile (`systemAudioAllowed`).
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from './core'

/** macOS's Audio Capture record (`SystemAudioPermission`); `unknown` when it could not be read. */
export type SystemAudioPermission = 'granted' | 'denied' | 'not_determined' | 'unknown'

/** The macOS privacy panes the banner opens. */
export type PrivacyPane = 'Privacy_Microphone' | 'Privacy_AudioCapture'

/**
 * Opens the default microphone for a moment, which makes the system ask for
 * access the first time; true when it opened. Call it before a level
 * preview, so the prompt comes from a step that explains it.
 */
export const requestMicrophonePermission = () => command<boolean>('trigger_microphone_permission')

/**
 * macOS: starts the Audio Capture tap, which asks for access the first time,
 * and listens for up to 5 s; true only when audible computer audio arrived,
 * so silence and a refusal both answer false. Play something first. Other
 * platforms answer true at once.
 */
export const probeSystemAudio = () => command<boolean>('trigger_system_audio_permission_command')

/** The Audio Capture record, read without a prompt; `granted` on Windows and Linux. */
export const getSystemAudioPermission = () => command<SystemAudioPermission>('get_system_audio_permission_status')

/** macOS only (elsewhere "Command not found"): opens a privacy pane of System Settings. */
export const openPrivacySettings = (pane: PrivacyPane) => command<null>('open_system_settings', {preferencePane: pane})

export const permissionKeys = {
    all: ['permissions'] as const,
    microphone: () => [...permissionKeys.all, 'microphone'] as const,
    systemAudio: () => [...permissionKeys.all, 'systemAudio'] as const,
    systemAudioProbe: () => [...permissionKeys.all, 'systemAudioProbe'] as const,
}

/**
 * Whether the microphone opened when asked (`requestMicrophonePermission`),
 * asked once per session by the screen that explains it; `refetch()` asks
 * again after the user changed the setting.
 */
export const microphoneAccessQuery = queryOptions({
    queryKey: permissionKeys.microphone(),
    queryFn: requestMicrophonePermission,
    staleTime: Infinity,
})

/** Read again with "Check again", or after a probe (invalidate `permissionKeys.all`). */
export const systemAudioPermissionQuery = queryOptions({
    queryKey: permissionKeys.systemAudio(),
    queryFn: getSystemAudioPermission,
})

/**
 * The last probe of this session, shared by every screen. It never runs on
 * its own (`enabled: false`): it may prompt and takes up to 5 s, so a screen
 * runs it on the user's click with `refetch()`. A reload forgets it, as a
 * permission revoked meanwhile must not stay trusted.
 */
export const systemAudioProbeQuery = queryOptions({
    queryKey: permissionKeys.systemAudioProbe(),
    queryFn: probeSystemAudio,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
})

/**
 * Whether computer audio can be recorded as far as permissions go: granted,
 * or, while the record is unread or not yet updated, heard by this session's
 * probe. A denial on record wins over an earlier probe.
 */
export function systemAudioAllowed(permission: SystemAudioPermission | undefined, heard: boolean | undefined): boolean {
    if (permission === 'granted') return true
    if (permission === 'denied') return false
    return heard === true
}
