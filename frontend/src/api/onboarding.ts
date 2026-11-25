/**
 * First launch (src-tauri/src/onboarding.rs) and the database it needs
 * (database/commands.rs, database/setup.rs). The shell gates the main window
 * on both at startup; first launch (features/onboarding) saves its step and
 * completes it.
 */
import {queryOptions} from '@tanstack/react-query'
import {platform as appPlatform, type Platform} from '@/lib/platform'
import {command} from './core'
import type {SummaryProvider} from './preferences'

/**
 * Native `OnboardingStatus`, kept in the `onboarding-status.json` store.
 * Only `complete_onboarding` writes `completed: true`, and first launch
 * saves its step only while it runs, so a completed first launch stays
 * completed. Installs from before the rewrite saved steps up to 5.
 */
export interface OnboardingStatus {
    version: string
    completed: boolean
    /** The step to come back to: 1 the name, 2 the models and the microphone. */
    current_step: number
    /** `downloaded` or `not_downloaded`, as `complete_onboarding` found them. */
    model_status: {
        parakeet: string
        summary: string
        selected_summary_model?: string
        /** The summary provider first launch chose; absent when it was left for later. */
        selected_summary_provider?: string
    }
    last_updated: string
}

export const onboardingKeys = {
    all: ['onboarding'] as const,
    status: () => [...onboardingKeys.all, 'status'] as const,
    database: () => [...onboardingKeys.all, 'database'] as const,
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

/** Saves the step first launch is on, so a restart comes back to it. Never after completion. */
export const saveOnboardingStep = (step: number) => command<null>('save_onboarding_status_cmd', {
    status: {
        version: '1.0',
        completed: false,
        current_step: step,
        model_status: {parakeet: 'not_downloaded', summary: 'not_downloaded'},
        // Native stamps its own time on save.
        last_updated: new Date().toISOString(),
    } satisfies OnboardingStatus,
})

/**
 * What first launch chose for summaries: built-in AI with its model, a
 * provider whose choice was saved already (`saveSummaryModelMutation`), or
 * nothing yet (`provider` null), which leaves summaries off.
 */
export interface SummaryChoice {
    provider: SummaryProvider | null
    model: string | null
    /** The built-in model is downloaded, or the provider's choice was saved. */
    ready: boolean
}

/**
 * Ends first launch: native saves Parakeet as the live model, and the
 * built-in model as the summary model when built-in AI was chosen; it
 * writes no other summary model, so a provider saved before this call stays
 * and a choice left for later stays unset. Then it marks the status
 * completed with what was chosen and ready by then. Needs the database.
 */
export const completeOnboarding = ({summary, parakeetReady}: {summary: SummaryChoice, parakeetReady: boolean}) =>
    command<null>('complete_onboarding', {
        provider: summary.provider,
        model: summary.model,
        parakeetReady,
        summaryReady: summary.ready,
    })

// --- The database --------------------------------------------------------------

/**
 * True while native code holds no database (`AppState`): on a new install
 * until one is set up, and after a set-up that failed, whose file may be
 * left behind.
 */
export const checkFirstLaunch = () => command<boolean>('check_first_launch')

/** A database left by the Homebrew-era Python backend on macOS; null when absent or empty. */
export const checkHomebrewDatabase = (path: string) =>
    command<{exists: boolean, size: number} | null>('check_homebrew_database', {path})

/** Copies an old database into the data folder as `meeting_minutes.db`, migrates it and opens it. */
export const importAndInitializeDatabase = (legacyDbPath: string) =>
    command<null>('import_and_initialize_database', {legacyDbPath})

/**
 * Opens the database, with Parakeet live and no summary model: first
 * launch records the one the user chooses. A Meetily database (`meeting_minutes.db`) already in the
 * data folder is migrated into it (`DatabaseManager::new`); otherwise it
 * starts empty.
 */
export const initializeFreshDatabase = () => command<null>('initialize_fresh_database')

/** Where the Homebrew installs of the old Python backend kept their database. */
export const HOMEBREW_DATABASES = [
    '/opt/homebrew/var/meetily/meeting_minutes.db',
    '/usr/local/var/meetily/meeting_minutes.db',
] as const

/**
 * Makes sure native code holds the database. Without it every database
 * command fails, `complete_onboarding` among them, so first launch never
 * completes, the updater's onboarding busy reason holds for good and no
 * update installs. On macOS a Homebrew-era database is imported, as in the
 * old app; otherwise `initialize_fresh_database` opens the data folder's
 * database, Meetily's included. A failure rejects, and the gate offers
 * Retry. With the database held it does nothing.
 */
export async function ensureDatabase(platform: Platform = appPlatform): Promise<void> {
    if (!(await checkFirstLaunch())) return
    if (platform === 'macos') {
        for (const path of HOMEBREW_DATABASES) {
            if ((await checkHomebrewDatabase(path).catch(() => null))?.exists) {
                await importAndInitializeDatabase(path)
                return
            }
        }
    }
    await initializeFreshDatabase()
}

/** The startup gate waits on it before anything reads meetings; Retry runs it again. */
export const databaseQuery = queryOptions({
    queryKey: onboardingKeys.database(),
    queryFn: async () => {
        await ensureDatabase()
        return true
    },
    staleTime: Infinity,
})
