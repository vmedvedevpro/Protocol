/**
 * First launch (src-tauri/src/onboarding.rs) and the database it needs
 * (database/commands.rs, database/setup.rs). The shell gates the main window
 * on both at startup; first launch (features/onboarding) saves its step and
 * completes it.
 */
import {queryOptions} from '@tanstack/react-query'
import {platform as appPlatform, type Platform} from '@/lib/platform'
import {command} from './core'
import type {NativeEvent} from './events'

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
 * Ends first launch: native saves the built-in `model` as the summary model
 * and Parakeet as the live model, then marks the status completed with what
 * was downloaded by then. Needs the database.
 */
export const completeOnboarding = (args: {model: string, parakeetReady: boolean, summaryReady: boolean}) =>
    command<null>('complete_onboarding', args)

// --- The database --------------------------------------------------------------

/**
 * Native sends it once, half a second after startup, when no database exists
 * yet. The window may not listen by then, so the shell also checks at
 * startup (`ensureDatabase`); the event only makes it check again.
 */
export const FIRST_LAUNCH_DETECTED_EVENT = 'first-launch-detected' as NativeEvent<null>

/** True while no database file exists: native then holds no database (AppState) until one is set up. */
export const checkFirstLaunch = () => command<boolean>('check_first_launch')

/** A Meetily database (`meeting_minutes.db`) in the data folder, to import; null when there is none. */
export const checkDefaultLegacyDatabase = () => command<string | null>('check_default_legacy_database')

/** A database left by the Homebrew-era Python backend on macOS; null when absent or empty. */
export const checkHomebrewDatabase = (path: string) =>
    command<{exists: boolean, size: number} | null>('check_homebrew_database', {path})

/** Copies an old database in, migrates it and opens it. */
export const importAndInitializeDatabase = (legacyDbPath: string) =>
    command<null>('import_and_initialize_database', {legacyDbPath})

/** Creates an empty database with Parakeet live and the recommended built-in summary model. */
export const initializeFreshDatabase = () => command<null>('initialize_fresh_database')

/** Where the Homebrew installs of the old Python backend kept their database. */
export const HOMEBREW_DATABASES = [
    '/opt/homebrew/var/meetily/meeting_minutes.db',
    '/usr/local/var/meetily/meeting_minutes.db',
] as const

/** What setting up the database did: `importError` when an old database was found but did not come in. */
export interface DatabaseSetUp {
    importError: string | null
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function setUpDatabase(platform: Platform): Promise<DatabaseSetUp> {
    if (!(await checkFirstLaunch())) return {importError: null}
    // Old databases to import, as the old app looked for them: Homebrew's
    // on macOS, then Meetily's in the data folder.
    const found: string[] = []
    if (platform === 'macos') {
        for (const path of HOMEBREW_DATABASES) {
            if ((await checkHomebrewDatabase(path).catch(() => null))?.exists) found.push(path)
        }
    }
    const legacy = await checkDefaultLegacyDatabase().catch(() => null)
    if (legacy) found.push(legacy)

    // As in the old app, a failed import goes on to the next database and
    // at last to an empty one: a database that cannot be read must not keep
    // the app from starting. The caller says what did not come in.
    let importError: string | null = null
    for (const path of found) {
        try {
            await importAndInitializeDatabase(path)
            return {importError: null}
        } catch (error) {
            importError = message(error)
        }
    }
    await initializeFreshDatabase()
    return {importError}
}

let settingUp: Promise<DatabaseSetUp> | null = null

/**
 * Makes sure the database exists and native code holds it. Without it every
 * database command fails, `complete_onboarding` among them, so first launch
 * never completes, the updater's onboarding busy reason holds for good and
 * no update installs. Imports an old database when there is one, else
 * creates a fresh one; with a database already there it does nothing.
 * Callers at the same time share one run.
 */
export function ensureDatabase(platform: Platform = appPlatform): Promise<DatabaseSetUp> {
    settingUp ??= setUpDatabase(platform).finally(() => {
        settingUp = null
    })
    return settingUp
}

/**
 * The startup gate waits on it before anything reads meetings; Retry and
 * `first-launch-detected` run it again.
 */
export const databaseQuery = queryOptions({
    queryKey: onboardingKeys.database(),
    queryFn: () => ensureDatabase(),
    staleTime: Infinity,
})
