import {useEffect, useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import {isFirstLaunchDone, onboardingStatusQuery} from '@/api/onboarding'

/**
 * How long "Checking setup…" waits before it offers Retry, as the old
 * layout did: the native side answers in milliseconds, so 8 s means it is
 * stuck (a store locked by another process, a slow disk) rather than busy.
 */
export const STARTUP_PATIENCE_MS = 8000

/**
 * Where the main window is at startup: still asking native code whether
 * first launch is done (`checking`, `slow` after `STARTUP_PATIENCE_MS`,
 * `failed`), on first launch, or `ready` for the app.
 */
export type StartupPhase = 'checking' | 'slow' | 'failed' | 'firstLaunch' | 'ready'

export function useStartupPhase(): { phase: StartupPhase, retry: () => void } {
    // Retry is the user's: no automatic retries hiding a failure for seconds.
    const status = useQuery({...onboardingStatusQuery, retry: false})
    const [attempt, setAttempt] = useState(0)
    const [slow, setSlow] = useState(false)
    const checking = status.isFetching && status.data === undefined

    useEffect(() => {
        if (!checking) return
        const timer = window.setTimeout(() => setSlow(true), STARTUP_PATIENCE_MS)
        return () => window.clearTimeout(timer)
    }, [checking, attempt])

    const retry = () => {
        setSlow(false)
        setAttempt(attempt + 1)
        void status.refetch()
    }

    if (status.isSuccess) return {phase: isFirstLaunchDone(status.data) ? 'ready' : 'firstLaunch', retry}
    if (status.isError && !status.isFetching) return {phase: 'failed', retry}
    return {phase: slow ? 'slow' : 'checking', retry}
}
