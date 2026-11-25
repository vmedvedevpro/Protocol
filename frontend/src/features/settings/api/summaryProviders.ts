/**
 * What Settings › Summary model asks the providers: the models each offers,
 * the models on an Ollama server and getting or removing one there, and a
 * test of a custom server. The choice itself is in `src/api/preferences.ts`.
 * Native code talks to the providers (anthropic/, openai/, groq/,
 * openrouter/, ollama/ and api/api.rs); the types mirror theirs.
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from '@/api/core'
import type {NativeEvent} from '@/api/events'
import type {SummaryProvider} from '@/api/preferences'
import claudeLimits from '@/lib/claude-output-limits.json'
import {safely} from '@/lib/storage'

/** The providers that need the user's own key. */
export type CloudProvider = Extract<SummaryProvider, 'claude' | 'openai' | 'groq' | 'openrouter'>

export const CLOUD_PROVIDERS: readonly CloudProvider[] = ['claude', 'openai', 'groq', 'openrouter']

export const isCloudProvider = (provider: SummaryProvider | ''): provider is CloudProvider =>
    (CLOUD_PROVIDERS as readonly string[]).includes(provider)

/** One model a provider offers, as the model select shows it. */
export interface ProviderModel {
    id: string
    label: string
}

/**
 * A cloud provider's models. Claude, OpenAI and Groq list them with the key
 * and answer their built-in list without one (anthropic.rs and the others
 * keep it); OpenRouter lists its public catalog.
 */
export async function getProviderModels(provider: CloudProvider, apiKey: string | null): Promise<ProviderModel[]> {
    switch (provider) {
        case 'claude': {
            const models = await command<{id: string, display_name?: string | null}[]>('get_anthropic_models', {apiKey})
            return models.map(({id, display_name}) => ({id, label: display_name || id}))
        }
        case 'openai':
            return (await command<{id: string}[]>('get_openai_models', {apiKey})).map(({id}) => ({id, label: id}))
        case 'groq':
            return (await command<{id: string}[]>('get_groq_models', {apiKey})).map(({id}) => ({id, label: id}))
        case 'openrouter':
            return (await command<{id: string, name: string}[]>('get_openrouter_models')).map(({id, name}) => ({id, label: name || id}))
    }
}

export const summaryProviderKeys = {
    all: ['summaryProviders'] as const,
    models: (provider: CloudProvider) => [...summaryProviderKeys.all, 'models', provider] as const,
    ollama: (endpoint: string | null) => [...summaryProviderKeys.all, 'ollama', endpoint ?? ''] as const,
}

/**
 * A provider's models, asked with `apiKey`. Keyed by the provider alone, so
 * no key is part of a query hash: the page refetches when the key it asks
 * with changes. Kept a few minutes, since a list changes rarely.
 */
export const providerModelsQuery = (provider: CloudProvider, apiKey: string | null) =>
    queryOptions({
        queryKey: summaryProviderKeys.models(provider),
        queryFn: () => getProviderModels(provider, apiKey),
        staleTime: 5 * 60_000,
        retry: false,
    })

// ---- Ollama ------------------------------------------------------------------------------

/** The server native uses when no endpoint is saved. */
export const OLLAMA_DEFAULT_ENDPOINT = 'http://localhost:11434'

/** The small model the old settings offered to get. */
export const OLLAMA_STARTER_MODEL = {name: 'gemma3:1b', description: 'A small model to start with', bytes: 815_000_000} as const

/** Mirrors `OllamaModel` in ollama/ollama.rs; `size` is already readable ("815 MB"). */
export interface OllamaModel {
    name: string
    id: string
    size: string
    modified: string
}

/** Native answers an empty server with this error; the UI reads it as no models. */
const NO_MODELS = /^No models found on the Ollama server/

/**
 * The models on an Ollama server (null: the saved or default endpoint).
 * Native tries the HTTP API for 5 s, then the CLI for a local server.
 */
export async function getOllamaModels(endpoint: string | null): Promise<OllamaModel[]> {
    try {
        return await command<OllamaModel[]>('get_ollama_models', {endpoint})
    } catch (error) {
        if (NO_MODELS.test(error instanceof Error ? error.message : String(error))) return []
        throw error
    }
}

/** No retries: a server that is not running would only keep the user waiting. */
export const ollamaModelsQuery = (endpoint: string | null) =>
    queryOptions({queryKey: summaryProviderKeys.ollama(endpoint), queryFn: () => getOllamaModels(endpoint), retry: false})

/**
 * Gets a model onto the server; resolves when it is there. Native holds the
 * updater's busy reason while it runs and refuses a second pull of the same
 * model ("… is already being downloaded"); progress comes by event.
 */
export const pullOllamaModel = (modelName: string, endpoint: string | null) =>
    command<null>('pull_ollama_model', {modelName, endpoint})

export const deleteOllamaModel = (modelName: string, endpoint: string | null) =>
    command<null>('delete_ollama_model', {modelName, endpoint})

/** A pull's percent, whole numbers as native sends them. */
export const OLLAMA_PULL_PROGRESS_EVENT = 'ollama-model-download-progress' as NativeEvent<{modelName: string, progress: number}>

/** Ollama is not installed or not running here (the old settings' check). */
export function isOllamaUnreachable(error: unknown) {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
    return ['cannot connect', 'connection refused', 'cli not found', 'not in path', 'timed out', 'error sending request']
        .some((pattern) => message.includes(pattern))
}

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'

// ---- Custom server -----------------------------------------------------------------------

/** Asks the server for one short completion; resolves with its message, rejects with why not. */
export const testCustomServer = ({endpoint, apiKey, model}: {endpoint: string, apiKey: string | null, model: string}) =>
    command<{status: string, message: string}>('api_test_custom_openai_connection', {endpoint, apiKey, model})

// ---- The last model of each provider -----------------------------------------------------

/** The old settings' key and format: `{"claude": "claude-sonnet-4-5", …}`. Keep reading. */
export const PROVIDER_MODEL_MAP_KEY = 'providerModelMap'

/**
 * The model the old settings last saved for each provider, read once when
 * the summary model page opens, so a provider switched to finds its model
 * again. Nothing writes it any more: within the page the draft keeps each
 * provider's model, and the saved provider's model is in the database.
 */
export function readLegacyModelMap(): Record<string, string> {
    const stored = safely(() => localStorage.getItem(PROVIDER_MODEL_MAP_KEY)) ?? null
    const parsed: unknown = stored ? safely(() => JSON.parse(stored)) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

// ---- Claude's output limits --------------------------------------------------------------

/**
 * The longest summary the app asks of a Claude model, from the limits
 * native compiles in (`summary/llm_client.rs`); unknown models get the
 * fallback. The same rule as the old settings' `claudeOutputBudget`.
 */
export function claudeOutputMaximum(model: string): number {
    const name = model.toLowerCase()
    const known = claudeLimits.models.find(({prefix}) => name === prefix || name.startsWith(prefix.endsWith('-') ? prefix : `${prefix}-`))
    return Math.min(claudeLimits.applicationLimit, known?.limit ?? claudeLimits.fallbackLimit)
}
