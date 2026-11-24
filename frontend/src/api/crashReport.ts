/**
 * The crash report a previous session left behind (src-tauri/src/crash_report.rs).
 * The shell offers it once at startup; the types mirror `PendingCrashReport`.
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from './core'
import {openExternalUrl} from './links'

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

/**
 * Asks where to save the ZIP, through the dialog plugin's save dialog
 * (`dialog:allow-save`). `null` when the user cancels.
 */
export async function chooseCrashReportDestination(report: PendingCrashReport): Promise<string | null> {
    const ask = (defaultPath: string) => command<string | null>('plugin:dialog|save', {
        options: {defaultPath, filters: [{name: 'ZIP archive', extensions: ['zip']}]},
    })
    const destination = await ask(`Protocol-crash-${report.reportId.slice(0, 8)}.zip`)
    if (!destination || destination.toLowerCase().endsWith('.zip')) return destination
    // A GTK dialog returns the name as typed, without the filter's extension,
    // and asked about replacing only that name. Adding `.zip` here would
    // replace an existing ZIP unasked, so the dialog opens once more on the
    // name with `.zip` and its own overwrite prompt runs. A name still without
    // it is refused by native code, which writes only a `.zip`.
    return ask(`${destination}.zip`)
}

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
