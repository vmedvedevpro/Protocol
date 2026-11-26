import {emit} from '@tauri-apps/api/event'
import type {NativeEvent} from '@/api/events'
import {type ModelListFailure, OLLAMA_PULL_PROGRESS_EVENT, type OllamaModel} from '@/api/summaryProviders'
import type {MockHandler} from './handlers'

/**
 * The summary providers as native reaches them (anthropic/, openai/, groq/,
 * openrouter/, ollama/, and the custom server test in api/api.rs).
 */
export interface MockSummaryProviders {
    /** An Ollama server answers (false: not installed or not running). */
    ollamaRunning: boolean
    ollamaModels: OllamaModel[]
    /** Percent a fake pull gains every tick; a test raises it to finish at once. */
    pullStep: number
    /** What the custom server test answers: null passes, a string is the failure. */
    customServerError: string | null
    /**
     * How Claude, OpenAI and Groq answer a listing with a key: null lists
     * the models, a failure rejects as native's `ModelListError` does. A key
     * that starts with "invalid" is always rejected (401), for the preview.
     */
    cloudModelsFailure: ModelListFailure | null
}

// Fake pulls still running; a new mock state stops those of the previous one.
const running = new Set<ReturnType<typeof setInterval>>()

export function createMockSummaryProviders(): MockSummaryProviders {
    for (const timer of running) clearInterval(timer)
    running.clear()
    return {
        ollamaRunning: true,
        ollamaModels: [
            {name: 'llama3.2:3b', id: 'a80c4f17acd5', size: '2.0 GB', modified: '3 weeks ago'},
        ],
        pullStep: 10,
        customServerError: null,
        cloudModelsFailure: null,
    }
}

/** What the providers list for any accepted key. */
const CLAUDE_MODELS = [
    {id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5'},
    {id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5'},
    {id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5'},
]
const OPENAI_MODELS = [{id: 'gpt-4o'}, {id: 'gpt-4o-mini'}, {id: 'o3-mini'}]
const GROQ_MODELS = [{id: 'llama-3.3-70b-versatile', owned_by: 'Meta'}, {id: 'gemma2-9b-it', owned_by: 'Google'}]
const OPENROUTER_MODELS = [
    {id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5', context_length: 200_000},
    {id: 'google/gemini-2.5-flash', name: 'Google: Gemini 2.5 Flash', context_length: 1_000_000},
]

const UNREACHABLE = 'Network error: error sending request for url (http://localhost:11434/api/tags). Please check your connection and endpoint URL.'

/** Native sends it at the end of a pull too; the page waits for the pull's own call instead. */
const OLLAMA_PULL_COMPLETE_EVENT = 'ollama-model-download-complete' as NativeEvent<{modelName: string}>

function send<T>(event: NativeEvent<T>, payload: T) {
    emit(event, payload).catch(() => undefined)
}

const TICK_MS = 200

/** A keyed listing as native answers it (cloud_models.rs): an error object, never a built-in list. */
function listed<T>(providers: MockSummaryProviders, apiKey: unknown, models: T[]): T[] {
    const key = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (!key) throw {kind: 'missingKey'} satisfies ModelListFailure
    if (/[^\x21-\x7e]/.test(key)) throw {kind: 'invalidKey'} satisfies ModelListFailure
    if (key.startsWith('invalid')) throw {kind: 'keyRejected', status: 401} satisfies ModelListFailure
    if (providers.cloudModelsFailure) throw structuredClone(providers.cloudModelsFailure)
    return structuredClone(models)
}

export function summaryProvidersHandlers(state: {summaryProviders: MockSummaryProviders}): Record<string, MockHandler> {
    const pulling = new Set<string>()
    return {
        get_anthropic_models: ({apiKey}) => listed(state.summaryProviders, apiKey, CLAUDE_MODELS),
        get_openai_models: ({apiKey}) => listed(state.summaryProviders, apiKey, OPENAI_MODELS),
        get_groq_models: ({apiKey}) => listed(state.summaryProviders, apiKey, GROQ_MODELS),
        get_openrouter_models: () => structuredClone(OPENROUTER_MODELS),
        get_ollama_models: () => {
            const ollama = state.summaryProviders
            if (!ollama.ollamaRunning) throw UNREACHABLE
            if (ollama.ollamaModels.length === 0) {
                throw "No models found on the Ollama server. Please pull models using 'ollama pull <model>'."
            }
            return structuredClone(ollama.ollamaModels)
        },
        pull_ollama_model: ({modelName}) => {
            const name = String(modelName)
            const ollama = state.summaryProviders
            if (!ollama.ollamaRunning) throw UNREACHABLE
            if (pulling.has(name)) throw `Model ${name} is already being downloaded`
            pulling.add(name)
            return new Promise((resolve) => {
                let progress = 0
                const timer = setInterval(() => {
                    progress = Math.min(100, progress + ollama.pullStep)
                    send(OLLAMA_PULL_PROGRESS_EVENT, {modelName: name, progress})
                    if (progress < 100) return
                    clearInterval(timer)
                    running.delete(timer)
                    pulling.delete(name)
                    if (!ollama.ollamaModels.some((model) => model.name === name)) {
                        ollama.ollamaModels.push({name, id: 'e2c1b9f04d33', size: '815 MB', modified: 'Just now'})
                    }
                    send(OLLAMA_PULL_COMPLETE_EVENT, {modelName: name})
                    resolve(null)
                }, TICK_MS)
                running.add(timer)
            })
        },
        delete_ollama_model: ({modelName}) => {
            const ollama = state.summaryProviders
            if (!ollama.ollamaRunning) throw UNREACHABLE
            const before = ollama.ollamaModels.length
            ollama.ollamaModels = ollama.ollamaModels.filter((model) => model.name !== modelName)
            if (ollama.ollamaModels.length === before) throw `Failed to delete model: model '${String(modelName)}' not found`
            return null
        },
        api_test_custom_openai_connection: ({endpoint}) => {
            const url = String(endpoint ?? '')
            if (!url.startsWith('http://') && !url.startsWith('https://')) throw 'Endpoint must start with http:// or https://'
            const error = state.summaryProviders.customServerError
            if (error) throw error
            return {status: 'success', message: 'Connection successful and response validated'}
        },
    }
}
