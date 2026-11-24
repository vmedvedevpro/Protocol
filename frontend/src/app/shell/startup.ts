import {useEffect, useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import {useNativeEvent} from '@/api/events'
import {databaseQuery, FIRST_LAUNCH_DETECTED_EVENT, isFirstLaunchDone, onboardingStatusQuery} from '@/api/onboarding'
import {toast} from '@/components/ui/toastStore'

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

export function useStartupPhase(): { phase: StartupPhase, retry: () => void } {
    // Retry is the user's: no automatic retries hiding a failure for seconds.
    const status = useQuery({...onboardingStatusQuery, retry: false})
    // Nothing may read meetings before the database exists (PARITY.md,
    // "A first launch creates the database"), so the app waits for it too.
    const database = useQuery({...databaseQuery, retry: false})
    const [attempt, setAttempt] = useState(0)
    const [slow, setSlow] = useState(false)
    const checking = (status.isFetching && status.data === undefined) || (database.isFetching && database.data === undefined)

    // Native says a new install has no database yet, if this window was
    // listening half a second after startup; the check above usually came
    // first, and a database it created makes this one do nothing.
    useNativeEvent(FIRST_LAUNCH_DETECTED_EVENT, () => void database.refetch())

    // An old database that did not come in leaves an empty one: say so, once.
    const importError = database.data?.importError
    useEffect(() => {
        if (importError) toast.error('Your meetings from Meetily were not imported', {description: importError})
    }, [importError])

    useEffect(() => {
        if (!checking) return
        const timer = window.setTimeout(() => setSlow(true), STARTUP_PATIENCE_MS)
        return () => window.clearTimeout(timer)
    }, [checking, attempt])

    const retry = () => {
        setSlow(false)
        setAttempt(attempt + 1)
        if (status.data === undefined) void status.refetch()
        if (database.data === undefined) void database.refetch()
    }

    if (status.isSuccess && database.isSuccess) {
        return {phase: isFirstLaunchDone(status.data) ? 'ready' : 'firstLaunch', retry}
    }
    if (status.isError && !status.isFetching) return {phase: 'failed', retry}
    if (database.isError && !database.isFetching) return {phase: 'databaseFailed', retry}
    return {phase: slow ? 'slow' : 'checking', retry}
}
