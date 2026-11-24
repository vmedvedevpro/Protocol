import type {SystemAudioPermission} from '@/api/permissions'
import type {MockHandler} from './handlers'
import {mockState} from './state'

/**
 * Microphone and computer-audio permissions. Their fields sit inline in
 * `createMockState` (`permissions`), so these read `mockState`. Windows and
 * Linux have no Audio Capture permission: there the status is `granted` and
 * the probe answers true, as native code does.
 */
export const permissionsHandlers: Record<string, MockHandler> = {
    // src-tauri/src/lib.rs
    trigger_microphone_permission: () => {
        mockState.permissions.asked.push('microphone')
        return mockState.permissions.microphone
    },
    // src-tauri/src/audio/permissions.rs
    trigger_system_audio_permission_command: () => {
        if (mockState.platform !== 'macos') return true
        mockState.permissions.asked.push('systemAudio')
        // The first probe shows the prompt, which the user answers.
        if (mockState.permissions.systemAudio === 'not_determined') mockState.permissions.systemAudio = mockState.permissions.answer
        return mockState.permissions.systemAudio !== 'denied' && mockState.permissions.audioPlaying
    },
    get_system_audio_permission_status: (): SystemAudioPermission =>
        mockState.platform === 'macos' ? mockState.permissions.systemAudio : 'granted',
}

/** Registered on macOS only (`utils.rs`). */
export const macosPermissionsHandlers: Record<string, MockHandler> = {
    open_system_settings: ({preferencePane}) => {
        mockState.permissions.openedPanes.push(String(preferencePane))
        return null
    },
}
