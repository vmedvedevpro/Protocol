import {type AudioDevice, deviceInUse, deviceLabel, type RecordingPreferences} from '@/api/devices'

/**
 * "Headset + all apps": the microphone a recording would open and what
 * computer audio records, as the bar's second line says it. A saved
 * microphone that is not connected reads as the default one, which is used.
 */
export function inputsSummary(preferences: RecordingPreferences | undefined, devices?: readonly AudioDevice[]): string {
    const {device} = deviceInUse(preferences?.preferred_mic_device, devices)
    const mic = device ? deviceLabel(device) : 'Default microphone'
    const apps = preferences?.per_app_recording_enabled ? 'chosen apps' : 'all apps'
    return `${mic} + ${apps}`
}

/** "Jabra Evolve2 isn’t connected": the saved devices a recording cannot open, or null. */
export function missingInputs(preferences: RecordingPreferences | undefined, devices?: readonly AudioDevice[]): string | null {
    const missing = [preferences?.preferred_mic_device, preferences?.preferred_system_device]
        .map((saved) => deviceInUse(saved, devices).missing)
        .filter((name): name is string => !!name)
    return missing.length > 0 ? `${missing.join(' and ')} ${missing.length > 1 ? 'aren’t' : 'isn’t'} connected` : null
}
