import type {SummaryModelConfig} from '@/api/preferences'
import type {MockHandler} from './handlers'

/** The summary model in the database, and the meeting language native holds in memory. */
export interface MockPreferences {
    /** Null on a database where nothing was saved yet (before first launch). */
    summaryModel: SummaryModelConfig | null
    /** What `set_language_preference` was last sent; null until it is. */
    languagePreference: string | null
}

/** What first launch saves: built-in AI with the model it downloaded (onboarding.rs). */
export function createMockPreferences(): MockPreferences {
    return {
        summaryModel: {
            provider: 'builtin-ai',
            model: 'qwen3.5:4b',
            whisperModel: 'large-v3',
            apiKey: null,
            ollamaEndpoint: null,
            summaryMaxTokens: null,
        },
        languagePreference: null,
    }
}

/**
 * `set_language_preference` (lib.rs) and `api_get_model_config`
 * (api/api.rs), spread into `handlers` with the mock state. The model's page
 * (#117) adds the save.
 */
export function preferencesHandlers(state: {preferences: MockPreferences}): Record<string, MockHandler> {
    return {
        set_language_preference: ({language}) => {
            if (language === undefined) {
                throw 'invalid args `language` for command `set_language_preference`: command set_language_preference missing required key language'
            }
            state.preferences.languagePreference = String(language)
            return null
        },
        api_get_model_config: () => structuredClone(state.preferences.summaryModel),
    }
}
