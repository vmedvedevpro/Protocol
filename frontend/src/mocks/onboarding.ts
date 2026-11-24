import type {OnboardingStatus} from '@/api/onboarding'
import type {MockHandler} from './handlers'

/**
 * First launch and the database (onboarding.rs, database/commands.rs). The
 * status is `mockState.onboarding`, which the shell's mock reads too
 * (`get_onboarding_status`); `mockState.database` says whether a database
 * exists and which old ones there are to import.
 */

/** A machine that finished first launch with everything downloaded. */
export function completedOnboarding(): OnboardingStatus {
    return {
        version: '1.0',
        completed: true,
        current_step: 5,
        model_status: {parakeet: 'downloaded', summary: 'downloaded', selected_summary_model: 'qwen3.5:4b'},
        last_updated: '2026-11-20T09:00:00Z',
    }
}

/**
 * A database that exists. A test of a new install sets `exists: false`, and
 * an old database to import with `legacyPath` or, on macOS,
 * `homebrewPaths`; `importError` makes every import fail with it.
 * `setUps` records each set-up (`fresh`, `import:<path>`), for tests.
 */
export function createMockDatabase() {
    return {
        exists: true,
        legacyPath: null as string | null,
        homebrewPaths: [] as string[],
        importError: null as string | null,
        setUps: [] as string[],
    }
}

export type MockDatabase = ReturnType<typeof createMockDatabase>

// Tauri's answer to a command whose State<AppState> was never managed.
const noDatabase = (command: string) =>
    `state not managed for field \`state\` on command \`${command}\`. You must call \`.manage()\` before using this command`

const now = () => new Date().toISOString()

export function onboardingHandlers(state: {onboarding: OnboardingStatus | null, database: MockDatabase}): Record<string, MockHandler> {
    const setUp = (how: string) => {
        state.database.exists = true
        state.database.setUps.push(how)
        return null
    }

    return {
        // src-tauri/src/database/commands.rs
        check_first_launch: () => !state.database.exists,
        check_default_legacy_database: () => state.database.legacyPath,
        check_homebrew_database: ({path}) =>
            state.database.homebrewPaths.includes(String(path)) ? {exists: true, size: 4_194_304} : null,
        import_and_initialize_database: ({legacyDbPath}) => {
            if (state.database.importError) throw state.database.importError
            return setUp(`import:${String(legacyDbPath)}`)
        },
        initialize_fresh_database: () => setUp('fresh'),

        // src-tauri/src/onboarding.rs
        save_onboarding_status_cmd: ({status}) => {
            state.onboarding = {...(status as OnboardingStatus), last_updated: now()}
            return null
        },
        complete_onboarding: ({model, parakeetReady, summaryReady}) => {
            if (!state.database.exists) throw noDatabase('complete_onboarding')
            state.onboarding = {
                version: '1.0',
                completed: true,
                current_step: 5,
                model_status: {
                    parakeet: parakeetReady ? 'downloaded' : 'not_downloaded',
                    summary: summaryReady ? 'downloaded' : 'not_downloaded',
                    selected_summary_model: String(model),
                },
                last_updated: now(),
            }
            return null
        },
    }
}
