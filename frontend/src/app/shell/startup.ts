import {useEffect, useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import {databaseQuery, isFirstLaunchDone, onboardingStatusQuery} from '@/api/onboarding'

/**
 * How long "Checking setup…" waits before it offers Retry, as the old
 * layout did: the native side answers in milliseconds, so 8 s means it is
 * stuck (a store locked by another process, a slow disk) rather than busy.
 * Importing an old database can take longer; Retry then joins the import
 * still running instead of starting another.
 */
export const STARTUP_PATIENCE_MS = 8000

/**
 * Where the main window is at startup: still asking native code whether
 * first launch is done and setting up the database (`checking`, `slow` after
 * `STARTUP_PATIENCE_MS`), unable to read the status (`failed`) or to set
 * up the database (`databaseFailed`), on first launch, or `ready` for the
 * app.
 */
export type StartupPhase = 'checking' | 'slow' | 'failed' | 'databaseFailed' | 'firstLaunch' | 'ready'

export function useStartupPhase(): { phase: StartupPhase, reason?: string, retry: () => void } {
    // Retry is the user's: no automatic retries hiding a failure for seconds.
    const status = useQuery({...onboardingStatusQuery, retry: false})
    // Nothing may read meetings before the database exists (PARITY.md,
    // "A first launch creates the database"), so the app waits for it too.
    const database = useQuery({...databaseQuery, retry: false})
    const [attempt, setAttempt] = useState(0)
    const [slow, setSlow] = useState(false)
    const checking = (status.isFetching && status.data === undefined) || (database.isFetching && database.data === undefined)

    useEffect(() => {
        if (!checking) return
        const timer = window.setTimeout(() => setSlow(true), STARTUP_PATIENCE_MS)
        return () => window.clearTimeout(timer)
    }, [checking, attempt])

    const retry = () => {
        setSlow(false)
        setAttempt(attempt + 1)
        if (status.data === undefined) void status.refetch()
        // Joins a set-up still running (a slow import) instead of cancelling it.
        if (database.data === undefined) void database.refetch({cancelRefetch: false})
    }

    if (status.isSuccess && database.isSuccess) {
        return {phase: isFirstLaunchDone(status.data) ? 'ready' : 'firstLaunch', retry}
    }
    if (status.isError && !status.isFetching) return {phase: 'failed', retry}
    // Native's words: a database that does not open says why (#121).
    if (database.isError && !database.isFetching) return {phase: 'databaseFailed', reason: database.error.message, retry}
    return {phase: slow ? 'slow' : 'checking', retry}
}
