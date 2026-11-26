/**
 * Protocol's log (src-tauri/src/app_log/): its status, Save logs, and the
 * WebView's errors written into it.
 */
import {queryOptions} from '@tanstack/react-query'
import {command, errorMessage} from './core'
import {chooseZipDestination} from './saveDialog'

export interface LogStatus {
    /** The log folder, as native resolved it. */
    folder: string
    /** Why the log is not, or not fully, written; null when it is. */
    problem: string | null
}

export const logKeys = {
    all: ['logs'] as const,
    status: () => [...logKeys.all, 'status'] as const,
}

export const logStatusQuery = queryOptions({
    queryKey: logKeys.status(),
    queryFn: () => command<LogStatus>('get_log_status'),
})

/** `Protocol-logs-2026-11-26.zip`, today's local date. */
export function logsFileName(now = new Date()) {
    const pad = (value: number) => String(value).padStart(2, '0')
    return `Protocol-logs-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.zip`
}

/** Asks where to save the logs; `null` when the user cancels. */
export const chooseLogsDestination = () => chooseZipDestination(logsFileName())

/** Writes the logs' ZIP to `destination` and returns the path written. */
export const saveLogsZip = (destination: string) => command<string>('save_logs_zip', {destination})

/** Shows the saved ZIP in the file manager. */
export const showSavedLogs = (path: string) => command<null>('show_saved_logs', {path})

export type WebViewErrorKind = 'error' | 'unhandled rejection' | 'screen error'

/**
 * Writes an error the WebView caught into the native log. Never throws: an
 * error report that fails has nowhere better to go than the console.
 */
export function logWebViewError(kind: WebViewErrorKind, error: unknown) {
    const message = errorMessage(error)
    const stack = error instanceof Error ? error.stack ?? null : null
    command<null>('log_webview_error', {kind, message, stack}).catch((failure: unknown) => {
        console.error('Could not write the error to the log', failure)
    })
}

/**
 * Sends the window's uncaught errors and unhandled rejections to the log, as
 * long as the page lives. Returns the removal, for tests.
 */
export function installErrorLogging(target: Window = window) {
    const onError = (event: ErrorEvent) => logWebViewError('error', event.error ?? event.message)
    const onRejection = (event: PromiseRejectionEvent) => logWebViewError('unhandled rejection', event.reason)
    target.addEventListener('error', onError)
    target.addEventListener('unhandledrejection', onRejection)
    return () => {
        target.removeEventListener('error', onError)
        target.removeEventListener('unhandledrejection', onRejection)
    }
}
