/**
 * What Settings › Summary model and first launch ask the providers: their
 * names, the models each offers,
 * the models on an Ollama server and getting or removing one there, and a
 * test of a custom server. The choice itself is in `src/api/preferences.ts`.
 * Native code talks to the providers (anthropic/, openai/, groq/,
 * openrouter/, ollama/ and api/api.rs); the types mirror theirs.
 */
import {queryOptions} from '@tanstack/react-query'
import {command, CommandError} from '@/api/core'
import type {NativeEvent} from '@/api/events'
import type {SummaryProvider} from '@/api/preferences'
import claudeLimits from '@/lib/claude-output-limits.json'
import {safely} from '@/lib/storage'

/**
 * The providers in the order the summary model page offers them, as the
 * row names them, and which need a key.
 */
export const SUMMARY_PROVIDERS: Record<SummaryProvider, {label: string; description: string; needsApiKey: boolean}> = {
    'builtin-ai': {label: 'Built-in AI', description: 'No API key needed', needsApiKey: false},
    claude: {label: 'Claude', description: 'Anthropic API key', needsApiKey: true},
    openai: {label: 'OpenAI', description: 'OpenAI API key', needsApiKey: true},
    groq: {label: 'Groq', description: 'Groq API key', needsApiKey: true},
    openrouter: {label: 'OpenRouter', description: 'OpenRouter API key', needsApiKey: true},
    ollama: {label: 'Ollama', description: 'Models on your own Ollama server', needsApiKey: false},
    'custom-openai': {label: 'Custom server', description: 'Any OpenAI-compatible endpoint', needsApiKey: false},
}

/** A built-in model's name without its tag: "Qwen 3.5 4B (High Quality)" is "Qwen 3.5 4B". */
export const shortModelName = (displayName: string) => displayName.replace(/\s*\([^)]*\)\s*$/, '')

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
 * Why native could not list a provider's models (`ModelListError` in
 * cloud_models.rs): it lists only what the provider answers for the key,
 * with no built-in list to fall back on.
 */
export type ModelListFailure =
    | {kind: 'missingKey'}
    | {kind: 'invalidKey'}
    | {kind: 'keyRejected', status: number}
    | {kind: 'unreachable', reason: string}
    | {kind: 'status', status: number, reason: string | null}
    | {kind: 'invalidResponse', reason: string}
    | {kind: 'clientUnavailable', reason: string}

const FAILURE_KINDS = new Set<string>(['missingKey', 'invalidKey', 'keyRejected', 'unreachable', 'status', 'invalidResponse', 'clientUnavailable'])

const isModelListFailure = (detail: unknown): detail is ModelListFailure =>
    typeof detail === 'object' && detail !== null && FAILURE_KINDS.has(String((detail as {kind?: unknown}).kind))

/** What the model row says for a failed listing, by its cause. */
export function modelListFailureText(provider: CloudProvider, failure: ModelListFailure): string {
    const {label} = SUMMARY_PROVIDERS[provider]
    switch (failure.kind) {
        case 'missingKey':
            return 'Paste a key to see the models.'
        case 'invalidKey':
            return 'This key has characters a key can’t have, such as a line break or a space. Paste it again.'
        case 'keyRejected':
            return `${label} didn’t accept this key (status ${failure.status}). Check that it’s pasted in full and still active.`
        case 'unreachable':
            return `Couldn’t reach ${label}: ${failure.reason}.`
        case 'status':
            return `${label} answered with status ${failure.status}${failure.reason ? ` ${failure.reason}` : ''}.`
        case 'invalidResponse':
            return `Couldn’t read ${label}’s list of models: ${failure.reason}.`
        case 'clientUnavailable':
            return `Couldn’t prepare the request to ${label}: ${failure.reason}.`
    }
}

/**
 * Whether asking again with the same key can help: the provider was not
 * reached or answered badly, OpenRouter's plain failures included. A
 * missing, malformed or rejected key needs the user to change the key, and
 * a client that cannot be built here would fail the same way again.
 */
export const isRetryableModelListError = (error: unknown) =>
    !(error instanceof ModelListError) || ['unreachable', 'status', 'invalidResponse'].includes(error.failure.kind)

/** A listing that failed, worded by its cause; `failure` keeps the cause. */
export class ModelListError extends Error {
    readonly failure: ModelListFailure

    constructor(provider: CloudProvider, failure: ModelListFailure) {
        super(modelListFailureText(provider, failure))
        this.name = 'ModelListError'
        this.failure = failure
    }
}

async function listed<T>(provider: CloudProvider, name: string, apiKey: string | null): Promise<T> {
    try {
        return await command<T>(name, {apiKey})
    } catch (error) {
        if (error instanceof CommandError && isModelListFailure(error.detail)) throw new ModelListError(provider, error.detail)
        throw error
    }
}

/**
 * A cloud provider's models: Claude, OpenAI and Groq list them for the key
 * (every page of them), and a rejected key or no answer rejects with a
 * `ModelListError`; OpenRouter lists its public catalog, which needs none.
 */
export async function getProviderModels(provider: CloudProvider, apiKey: string | null): Promise<ProviderModel[]> {
    switch (provider) {
        case 'claude': {
            const models = await listed<{id: string, display_name?: string | null}[]>(provider, 'get_anthropic_models', apiKey)
            return models.map(({id, display_name}) => ({id, label: display_name || id}))
        }
        case 'openai':
            return (await listed<{id: string}[]>(provider, 'get_openai_models', apiKey)).map(({id}) => ({id, label: id}))
        case 'groq':
            return (await listed<{id: string}[]>(provider, 'get_groq_models', apiKey)).map(({id}) => ({id, label: id}))
        case 'openrouter':
            return (await command<{id: string, name: string}[]>('get_openrouter_models')).map(({id, name}) => ({id, label: name || id}))
    }
}

/** OpenRouter's catalog is public; the other providers list models only for a key. */
export const listsWithoutKey = (provider: CloudProvider) => provider === 'openrouter'

/**
 * A short fingerprint of a key for the models query's key (cyrb53, 53 bits):
 * each key gets its own cache entry, so a list fetched with one key is never
 * shown for another, and the key itself stays out of the query cache.
 */
export function keyFingerprint(key: string): string {
    let h1 = 0xdeadbeef
    let h2 = 0x41c6ce57
    for (let i = 0; i < key.length; i++) {
        const code = key.charCodeAt(i)
        h1 = Math.imul(h1 ^ code, 2654435761)
        h2 = Math.imul(h2 ^ code, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export const summaryProviderKeys = {
    all: ['summaryProviders'] as const,
    models: (provider: CloudProvider, apiKey: string | null) =>
        [...summaryProviderKeys.all, 'models', provider, listsWithoutKey(provider) || !apiKey ? '' : keyFingerprint(apiKey)] as const,
    ollama: (endpoint: string | null) => [...summaryProviderKeys.all, 'ollama', endpoint ?? ''] as const,
}

/**
 * A provider's models, asked with `apiKey`; nothing is asked without a key
 * unless the provider lists without one. Keyed by the key's fingerprint, so
 * a new key starts empty and pending rather than showing another key's
 * list. Kept a few minutes, since a list changes rarely.
 */
export const providerModelsQuery = (provider: CloudProvider, apiKey: string | null) =>
    queryOptions({
        queryKey: summaryProviderKeys.models(provider, apiKey),
        queryFn: () => getProviderModels(provider, apiKey),
        enabled: listsWithoutKey(provider) || Boolean(apiKey),
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
