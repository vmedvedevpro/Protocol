import type {CustomServerConfig, SummaryModelConfig, SummaryProvider} from '@/api/preferences'
import type {MockHandler} from './handlers'

/** The summary model in the database, and the meeting language native holds in memory. */
export interface MockPreferences {
    /** Null on a database where nothing was saved yet (before first launch). */
    summaryModel: SummaryModelConfig | null
    /** What `set_language_preference` was last sent; null until it is. */
    languagePreference: string | null
    /** The keys saved per provider. */
    apiKeys: Partial<Record<SummaryProvider, string>>
    /** The custom server, null until one was saved. */
    customServer: CustomServerConfig | null
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
        apiKeys: {},
        customServer: null,
    }
}

/**
 * `set_language_preference` (lib.rs) and the summary model's commands in
 * api/api.rs, spread into `handlers` with the mock state.
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
        // The saved provider's key comes with the choice, as native reads it.
        api_get_model_config: () => {
            const config = state.preferences.summaryModel
            if (!config) return null
            const key = config.provider ? state.preferences.apiKeys[config.provider] : undefined
            return {...structuredClone(config), apiKey: key ?? null}
        },
        api_save_model_config: ({provider, model, whisperModel, apiKey, ollamaEndpoint, summaryMaxTokens}) => {
            const tokens = summaryMaxTokens === undefined || summaryMaxTokens === null ? null : Number(summaryMaxTokens)
            if (tokens !== null && (tokens < 1 || tokens > 64000)) throw 'Maximum summary length must be between 1 and 64000, or left empty'
            const chosen = String(provider) as SummaryProvider
            state.preferences.summaryModel = {
                provider: chosen,
                model: String(model),
                whisperModel: String(whisperModel),
                apiKey: null,
                ollamaEndpoint: (ollamaEndpoint as string | null | undefined) ?? null,
                summaryMaxTokens: tokens,
            }
            if (typeof apiKey === 'string' && apiKey && chosen !== 'custom-openai') state.preferences.apiKeys[chosen] = apiKey
            return {status: 'success', message: 'Model configuration saved successfully'}
        },
        api_get_api_key: ({provider}) => state.preferences.apiKeys[String(provider) as SummaryProvider] ?? '',
        api_get_custom_openai_config: () => structuredClone(state.preferences.customServer),
        api_save_custom_openai_config: ({endpoint, apiKey, model, maxTokens, temperature, topP}) => {
            const url = String(endpoint ?? '').trim()
            if (!url.startsWith('http://') && !url.startsWith('https://')) throw 'Endpoint must start with http:// or https://'
            if (!String(model ?? '').trim()) throw 'Model name is required'
            state.preferences.customServer = {
                endpoint: url,
                apiKey: (apiKey as string | null | undefined) ?? null,
                model: String(model).trim(),
                maxTokens: (maxTokens as number | null | undefined) ?? null,
                temperature: (temperature as number | null | undefined) ?? null,
                topP: (topP as number | null | undefined) ?? null,
            }
            return {status: 'success', message: 'Custom OpenAI configuration saved successfully'}
        },
    }
}
