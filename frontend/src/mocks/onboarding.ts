import type {OnboardingStatus} from '@/api/onboarding'
import type {SummaryModelConfig} from '@/api/preferences'
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
        model_status: {parakeet: 'downloaded', summary: 'downloaded', selected_summary_model: 'qwen3.5:4b', selected_summary_provider: 'builtin-ai'},
        last_updated: '2026-11-20T09:00:00Z',
    }
}

/**
 * Whether native code holds the database (`AppState`); a test of a new
 * install sets `exists: false`. `homebrewPaths` are old databases to
 * import on macOS. `setUps` records each set-up (`fresh`,
 * `import:<path>`), for tests.
 */
export function createMockDatabase() {
    return {
        exists: true,
        homebrewPaths: [] as string[],
        setUps: [] as string[],
    }
}

export type MockDatabase = ReturnType<typeof createMockDatabase>

// Tauri's answer to a command whose State<AppState> was never managed.
const noDatabase = (command: string) =>
    `state not managed for field \`state\` on command \`${command}\`. You must call \`.manage()\` before using this command`

const now = () => new Date().toISOString()

export function onboardingHandlers(state: {
    onboarding: OnboardingStatus | null
    database: MockDatabase
    preferences: {summaryModel: SummaryModelConfig | null}
}): Record<string, MockHandler> {
    const setUp = (how: string) => {
        state.database.exists = true
        state.database.setUps.push(how)
        return null
    }

    return {
        // src-tauri/src/database/commands.rs
        check_first_launch: () => !state.database.exists,
        check_homebrew_database: ({path}) =>
            state.database.homebrewPaths.includes(String(path)) ? {exists: true, size: 4_194_304} : null,
        import_and_initialize_database: ({legacyDbPath}) => setUp(`import:${String(legacyDbPath)}`),
        // A fresh database has no summary model until first launch records one.
        initialize_fresh_database: () => {
            state.preferences.summaryModel = null
            return setUp('fresh')
        },

        // src-tauri/src/onboarding.rs
        save_onboarding_status_cmd: ({status}) => {
            state.onboarding = {...(status as OnboardingStatus), last_updated: now()}
            return null
        },
        // Writes the summary model only for built-in AI, as native does.
        complete_onboarding: ({provider, model, parakeetReady, summaryReady}) => {
            if (!state.database.exists) throw noDatabase('complete_onboarding')
            if (provider === 'builtin-ai' && typeof model === 'string') {
                state.preferences.summaryModel = {
                    provider: 'builtin-ai',
                    model,
                    whisperModel: 'large-v3',
                    apiKey: null,
                    ollamaEndpoint: null,
                    summaryMaxTokens: null,
                }
            }
            state.onboarding = {
                version: '1.0',
                completed: true,
                current_step: 5,
                model_status: {
                    parakeet: parakeetReady ? 'downloaded' : 'not_downloaded',
                    summary: summaryReady ? 'downloaded' : 'not_downloaded',
                    ...(typeof model === 'string' ? {selected_summary_model: model} : {}),
                    ...(typeof provider === 'string' ? {selected_summary_provider: provider} : {}),
                },
                last_updated: now(),
            }
            return null
        },
    }
}
