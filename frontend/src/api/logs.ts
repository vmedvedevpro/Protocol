/**
 * Protocol's log (src-tauri/src/app_log/): its status, Save logs, and the
 * WebView's errors written into it.
 */
import {queryOptions} from '@tanstack/react-query'
import {isoDate} from '@/lib/dates'
import {command, errorMessage} from './core'
import {chooseZipDestination} from './saveDialog'

export interface LogStatus {
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
export const logsFileName = (now = new Date()) => `Protocol-logs-${isoDate(now)}.zip`

/** Asks where to save the logs; `null` when the user cancels. */
export const chooseLogsDestination = () => chooseZipDestination(logsFileName())

/** Writes the logs' ZIP to `destination`. */
export const saveLogsZip = (destination: string) => command<null>('save_logs_zip', {destination})

/** Shows the saved ZIP in the file manager. */
export const showSavedLogs = (path: string) => command<null>('show_saved_logs', {path})

export type WebViewErrorKind = 'error' | 'unhandled rejection' | 'screen error'

/**
 * How long the same error is not logged again. A render loop or a timer
 * repeats one error many times a second; one line per 5 s keeps the burst
 * visible without filling the log, and native caps the rest a minute.
 */
const REPEAT_MS = 5_000
/**
 * Errors remembered for the repeat filter, at most. An error whose text
 * changes every time (an id, a time) would add a key each time; clearing
 * the map past this costs at most one extra line per error.
 */
const REMEMBERED_MAX = 100
const lastLogged = new Map<string, number>()

/**
 * Chromium's note that a ResizeObserver callback resized what it observes,
 * reported as an error though nothing failed: the layout settles a frame
 * later.
 */
const RESIZE_OBSERVER_LOOP = /^ResizeObserver loop/

/**
 * Writes an error the WebView caught into the native log. Never throws: an
 * error report that fails has nowhere better to go than the console.
 */
export function logWebViewError(kind: WebViewErrorKind, error: unknown, now = Date.now()) {
    const message = errorMessage(error)
    const stack = error instanceof Error ? error.stack ?? null : null
    if (RESIZE_OBSERVER_LOOP.test(message)) return
    const key = `${kind}\n${message}\n${stack ?? ''}`
    if (now - (lastLogged.get(key) ?? -Infinity) < REPEAT_MS) return
    if (lastLogged.size >= REMEMBERED_MAX) lastLogged.clear()
    lastLogged.set(key, now)
    command<null>('log_webview_error', {kind, message, stack}).catch((failure: unknown) => {
        console.error('Could not write the error to the log', failure)
    })
}

/**
 * Sends the window's uncaught errors and unhandled rejections to the log, as
 * long as the page lives. Returns the removal, for tests.
 */
export function installErrorLogging() {
    const onError = (event: ErrorEvent) => logWebViewError('error', event.error ?? event.message)
    const onRejection = (event: PromiseRejectionEvent) => logWebViewError('unhandled rejection', event.reason)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
        window.removeEventListener('error', onError)
        window.removeEventListener('unhandledrejection', onRejection)
    }
}
