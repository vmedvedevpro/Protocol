/**
 * The in-app updater (src-tauri/src/updater/). Native code owns every check,
 * download and install; each command returns one snapshot, and the same
 * snapshot is pushed to every window as `updater-status`. These types mirror
 * `Snapshot` in updater/mod.rs.
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from './core'

export const UPDATER_STATUS_EVENT = 'updater-status'

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
