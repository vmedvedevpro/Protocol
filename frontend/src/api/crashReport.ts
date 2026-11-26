/**
 * The crash report a previous session left behind (src-tauri/src/crash_report.rs).
 * The shell offers it once at startup; the types mirror `PendingCrashReport`.
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from './core'
import {openExternalUrl} from './links'
import {chooseZipDestination} from './saveDialog'

export type CrashType = 'panic' | 'unexpected_exit'

export interface PendingCrashReport {
    reportId: string
    /** RFC 3339. */
    detectedAt: string
    crashType: CrashType
    appVersion: string
}

export const crashReportKeys = {
    all: ['crashReport'] as const,
    pending: () => [...crashReportKeys.all, 'pending'] as const,
}

export const getPendingCrashReport = () => command<PendingCrashReport | null>('get_pending_crash_report')

export const pendingCrashReportQuery = queryOptions({
    queryKey: crashReportKeys.pending(),
    queryFn: getPendingCrashReport,
    // Written once by the session that crashed; only dismissing removes it.
    staleTime: Infinity,
})

/** Writes the report's ZIP to `destination` and returns the path written. */
export const createCrashReportZip = (destination: string) =>
    command<string>('create_crash_report_zip', {destination})

/** Removes the pending report, so the next launch does not offer it again. */
export const dismissPendingCrashReport = () => command<void>('dismiss_pending_crash_report')

/** Asks where to save the report's ZIP; `null` when the user cancels. */
export const chooseCrashReportDestination = (report: PendingCrashReport) =>
    chooseZipDestination(`Protocol-crash-${report.reportId.slice(0, 8)}.zip`)

const ISSUE_BODY = [
    '## Crash report',
    '',
    'Please attach the ZIP Protocol just created, then describe what was happening before the crash.',
].join('\n')

/** Opens a new public GitHub issue for the report; the user attaches the ZIP there. */
export const openCrashReportIssue = () =>
    openExternalUrl(
        `https://github.com/vmedvedevpro/Protocol/issues/new?${new URLSearchParams({
            title: 'Protocol crash report',
            body: ISSUE_BODY,
        })}`,
    )
