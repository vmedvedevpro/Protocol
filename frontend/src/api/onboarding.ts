/**
 * First launch (src-tauri/src/onboarding.rs). The shell gates the main window
 * on it at startup; first launch itself (#115) changes it.
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from './core'

/**
 * The part of native `OnboardingStatus` the UI reads so far; first launch
 * (#115) adds the fields it reads.
 */
export interface OnboardingStatus {
    completed: boolean
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
