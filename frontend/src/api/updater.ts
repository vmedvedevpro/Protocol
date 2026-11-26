/**
 * The in-app updater (src-tauri/src/updater/). Native code owns every check,
 * download and install; each command returns one snapshot, and the same
 * snapshot is pushed to every window as `updater-status`. These types mirror
 * `Snapshot` in updater/mod.rs.
 */
import {queryOptions} from '@tanstack/react-query'
import {command, CommandError} from './core'
import {type NativeEvent, useEventQuerySync} from './events'

export type BusyReason =
    | 'recording'
    | 'recordingStopping'
    | 'recordingSave'
    | 'import'
    | 'retranscription'
    | 'diarization'
    | 'summary'
    | 'postCall'
    | 'modelDownload'
    | 'modelCompile'
    | 'onboarding'
    | 'speechCheck'
    | 'speechEngine'

export type UpdateErrorKind =
    | 'network'
    | 'noRelease'
    | 'noPlatform'
    | 'feed'
    | 'signature'
    | 'download'
    | 'diskSpace'
    | 'installStart'
    | 'installIncomplete'
    | 'location'

export interface Release {
    version: string
    notes: string | null
    date: string | null
}

export interface Offer {
    release: Release
    downloaded: boolean
    manualOnly: boolean
    waitingForRecording: boolean
}

export interface UpdateError {
    kind: UpdateErrorKind
    action: 'check' | 'download' | 'install'
    message: string
    /** Unix time in milliseconds. */
    at: number
    background: boolean
}

export type UpdateActivity =
    | {state: 'idle'}
    | {state: 'checking'; manual: boolean}
    | {state: 'downloading'; received: number; total: number | null}
    | {state: 'installing'}

export type UpdateSupport =
    | {kind: 'updatable'; install: string}
    | {kind: 'manualOnly'; install: string}
    | {kind: 'off'; reason: 'dev' | 'notInstalled'}

export interface UpdaterSnapshot {
    currentVersion: string
    platform: 'windows' | 'macos' | 'linux'
    support: UpdateSupport
    autoCheck: boolean
    /** Unix time in milliseconds. */
    lastCheckedAt: number | null
    activity: UpdateActivity
    offer: Offer | null
    error: UpdateError | null
    busyReasons: BusyReason[]
    updatedFrom: string | null
}

/** Sent to every window whenever the snapshot changes. */
export const UPDATER_STATUS_EVENT = 'updater-status' as NativeEvent<UpdaterSnapshot>

export const updaterKeys = {
    all: ['updater'] as const,
    status: () => [...updaterKeys.all, 'status'] as const,
}

export const getUpdaterStatus = () => command<UpdaterSnapshot>('updater_get_status')

export const updaterStatusQuery = queryOptions({
    queryKey: updaterKeys.status(),
    queryFn: getUpdaterStatus,
    // `updater-status` keeps the cache current (useUpdaterStatusSync); a
    // refetch would only repeat what the event already delivered.
    staleTime: Infinity,
})

/**
 * Native code pushes the whole snapshot to every window on each change; the
 * event keeps the cached one current. Mounted once, in App; a story or test
 * that shows the status without App mounts it itself.
 */
export function useUpdaterStatusSync() {
    useEventQuerySync(UPDATER_STATUS_EVENT, updaterStatusQuery.queryKey)
}

/**
 * Why `updater_install_now` refused: nothing verified to install (or another
 * update operation runs), or work that must not be interrupted, named by its
 * reasons. Mirrors `install::Refusal`; an install that was tried and failed
 * resolves instead, with the error in the snapshot.
 */
export type InstallRefusal =
    | {kind: 'notReady'}
    | {kind: 'busy'; reasons: BusyReason[]}

/** The refusal an `installUpdate()` rejection carries; null for any other error. */
export function installRefusal(error: unknown): InstallRefusal | null {
    if (!(error instanceof CommandError)) return null
    const {detail} = error
    return typeof detail === 'object' && detail !== null && 'kind' in detail ? detail as InstallRefusal : null
}

/** Asks GitHub for a newer release now (the app row's Check). */
export const checkForUpdates = () => command<UpdaterSnapshot>('updater_check_now')

/** Downloads the offered release. Only a click calls it: nothing downloads on its own. */
export const downloadUpdate = () => command<UpdaterSnapshot>('updater_download_now')

/**
 * Restart and update: installs the downloaded release and restarts, unless
 * work is running; then it rejects with an `InstallRefusal` (the
 * CommandError's `detail`).
 */
export const installUpdate = () => command<UpdaterSnapshot>('updater_install_now')

/** The daily check for app and model updates (`updater.json`). */
export const setUpdateAutoCheck = (enabled: boolean) => command<UpdaterSnapshot>('updater_set_auto_check', {enabled})

/** How much of a running download has arrived, 0 to 100; null when the size is unknown. */
export function downloadPercent(activity: UpdateActivity): number | null {
    if (activity.state !== 'downloading' || !activity.total) return null
    return Math.min(100, Math.round((activity.received / activity.total) * 100))
}
