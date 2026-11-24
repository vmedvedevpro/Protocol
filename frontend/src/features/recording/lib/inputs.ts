import {deviceLabel, type RecordingPreferences} from '@/api/devices'

/**
 * "Headset + all apps": the microphone and what computer audio records, as
 * the bar's second line says it.
 */
export function inputsSummary(preferences: RecordingPreferences | undefined): string {
    const mic = preferences?.preferred_mic_device ? deviceLabel(preferences.preferred_mic_device) : 'Default microphone'
    const apps = preferences?.per_app_recording_enabled ? 'chosen apps' : 'all apps'
    return `${mic} + ${apps}`
}
