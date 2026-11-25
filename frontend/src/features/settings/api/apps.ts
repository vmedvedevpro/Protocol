/**
 * The apps whose sound a recording can take alone (Windows and macOS;
 * audio/recording_preferences.rs, audio/capture/per_app.rs). The chosen ones
 * are `per_app_targets` in the recording preferences (src/api/devices.ts);
 * these are the commands only Settings uses to find them.
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from '@/api/core'
import type {PerAppTarget} from '@/api/devices'

/** Mirrors `RecordableApp` in per_app.rs: an app running now. */
export interface RecordableApp {
    id: string
    name: string
    /** The program's file name, `Zoom.exe`; what a chosen app is matched by. */
    executable: string
    pid: number | null
    /** Playing sound now (Windows; macOS never says). */
    has_audio: boolean
    icon: string | null
}

export const recordableAppKeys = {
    all: ['recordableApps'] as const,
}

/** Lists the running apps once per visit of the page: it walks every process. */
export const recordableAppsQuery = queryOptions({
    queryKey: recordableAppKeys.all,
    queryFn: () => command<RecordableApp[]>('get_recordable_apps'),
    staleTime: 0,
})

/** The system's file picker for an app that is not open; null when the user cancels. */
export const pickAppExecutable = () => command<RecordableApp | null>('select_custom_app_executable')

/** Apps are the same app when their programs are, in any case. */
export const sameApp = (a: {executable: string}, b: {executable: string}) =>
    a.executable.toLowerCase() === b.executable.toLowerCase()

/** What the preferences keep of an app: a running one's id may be its process, so the program stands in. */
export const targetOf = (app: RecordableApp | PerAppTarget): PerAppTarget => ({
    id: app.id || app.executable,
    name: app.name,
    executable: app.executable,
    icon: app.icon ?? null,
})
