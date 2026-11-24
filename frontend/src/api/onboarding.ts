/**
 * First launch (src-tauri/src/onboarding.rs). The shell gates the main window
 * on it at startup; first launch itself (#115) changes it. The types mirror
 * `OnboardingStatus` and `ModelStatus` there.
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from './core'

export interface OnboardingModelStatus {
    /** `downloaded`, `not_downloaded` or `downloading`. */
    parakeet: string
    summary: string
    selected_summary_model?: string
}

export interface OnboardingStatus {
    version: string
    completed: boolean
    current_step: number
    model_status: OnboardingModelStatus
    last_updated: string
}

export const onboardingKeys = {
    all: ['onboarding'] as const,
    status: () => [...onboardingKeys.all, 'status'] as const,
}

/** `null` until first launch has saved anything: a new install. */
export const getOnboardingStatus = () => command<OnboardingStatus | null>('get_onboarding_status')

export const onboardingStatusQuery = queryOptions({
    queryKey: onboardingKeys.status(),
    queryFn: getOnboardingStatus,
    // Only first launch changes it, and it invalidates this key when it does.
    staleTime: Infinity,
})

/** Whether first launch is done; until it is, nothing may start a recording. */
export const isFirstLaunchDone = (status: OnboardingStatus | null | undefined) => status?.completed === true
