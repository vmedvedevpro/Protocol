import type {CustomServerConfig, SummaryModelChoice, SummaryModelConfig, SummaryProvider} from '@/api/preferences'
import {
    claudeOutputMaximum,
    isCloudProvider,
    parseSummaryLength,
} from '../../api/summaryProviders'

/**
 * What the summary model page holds until Save: the fields as typed. A
 * provider switched to and back keeps what was typed for it.
 */
export interface SummaryModelDraft {
    /** '' while nothing is chosen (a removed provider): Save stays off. */
    provider: SummaryProvider | ''
    /** The model chosen for each provider. */
    models: Partial<Record<SummaryProvider, string>>
    /** Keys typed per cloud provider; a provider not here shows its saved key. */
    apiKeys: Partial<Record<SummaryProvider, string>>
    /** Claude's maximum summary length as typed; empty for the model's default. */
    maxLength: string
    ollamaEndpoint: string
    /** The endpoint whose models are listed: Fetch models takes the typed one. */
    ollamaFetched: string
    custom: Record<'endpoint' | 'model' | 'apiKey' | 'maxTokens' | 'temperature' | 'topP', string>
}

const text = (value: number | string | null | undefined) => (value === null || value === undefined ? '' : String(value))

/**
 * The page's starting point: the saved choice, and for every other
 * provider the model last saved with it (`providerModelMap`).
 */
export function initialDraft(
    config: SummaryModelConfig | null,
    customServer: CustomServerConfig | null,
    modelMap: Record<string, string>,
): SummaryModelDraft {
    const models: SummaryModelDraft['models'] = {...modelMap}
    if (config?.provider && config.model) models[config.provider] = config.model
    const endpoint = config?.ollamaEndpoint ?? ''
    return {
        provider: config?.provider ?? '',
        models,
        apiKeys: {},
        maxLength: config?.provider === 'claude' ? text(config.summaryMaxTokens) : '',
        ollamaEndpoint: endpoint,
        ollamaFetched: endpoint,
        custom: {
            endpoint: customServer?.endpoint ?? '',
            model: customServer?.model ?? '',
            apiKey: customServer?.apiKey ?? '',
            maxTokens: text(customServer?.maxTokens),
            temperature: text(customServer?.temperature),
            topP: text(customServer?.topP),
        },
    }
}

/** A number typed in a field: null when empty, undefined when it is not one within the bounds. */
export function parseNumber(value: string, min: number, max: number, {whole = false} = {}): number | null | undefined {
    const trimmed = value.trim()
    if (!trimmed) return null
    const number = Number(trimmed)
    if (!Number.isFinite(number) || number < min || number > max) return undefined
    if (whole && !Number.isInteger(number)) return undefined
    return number
}

export const CUSTOM_LIMITS = {
    maxTokens: {min: 1, max: 1_000_000, whole: true},
    temperature: {min: 0, max: 2},
    topP: {min: 0, max: 1},
} as const

/** The custom server as typed, or undefined while a field is not valid. */
export function customServerOf(draft: SummaryModelDraft): CustomServerConfig | undefined {
    const {endpoint, model, apiKey, maxTokens, temperature, topP} = draft.custom
    const url = endpoint.trim()
    if (!/^https?:\/\//.test(url) || !model.trim()) return undefined
    const numbers = {
        maxTokens: parseNumber(maxTokens, CUSTOM_LIMITS.maxTokens.min, CUSTOM_LIMITS.maxTokens.max, {whole: true}),
        temperature: parseNumber(temperature, CUSTOM_LIMITS.temperature.min, CUSTOM_LIMITS.temperature.max),
        topP: parseNumber(topP, CUSTOM_LIMITS.topP.min, CUSTOM_LIMITS.topP.max),
    }
    if (Object.values(numbers).some((number) => number === undefined)) return undefined
    return {
        endpoint: url,
        model: model.trim(),
        apiKey: apiKey.trim() || null,
        maxTokens: numbers.maxTokens ?? null,
        temperature: numbers.temperature ?? null,
        topP: numbers.topP ?? null,
    }
}

export interface SaveContext {
    /** The key the field shows for a cloud provider: typed, else saved. */
    apiKey: string
    /** Built-in AI: the chosen model is downloaded. */
    builtInReady: boolean
    /** Written back as it was read: the summary model's row stores it too. */
    whisperModel: string
}

/**
 * What Save stores, or undefined while something is missing: a provider,
 * a model, a cloud provider's key, a downloaded built-in model, Ollama's
 * models fetched from the endpoint typed, a valid length or custom server.
 */
export function choiceOf(draft: SummaryModelDraft, context: SaveContext): {choice: SummaryModelChoice, customServer?: CustomServerConfig} | undefined {
    const {provider} = draft
    if (!provider) return undefined
    const base = {provider, whisperModel: context.whisperModel, apiKey: null, ollamaEndpoint: null, summaryMaxTokens: null}
    const model = draft.models[provider]?.trim() ?? ''

    if (provider === 'custom-openai') {
        const customServer = customServerOf(draft)
        return customServer && {choice: {...base, model: customServer.model}, customServer}
    }
    if (!model) return undefined
    if (provider === 'builtin-ai') return context.builtInReady ? {choice: {...base, model}} : undefined
    if (provider === 'ollama') {
        const endpoint = draft.ollamaEndpoint.trim()
        if (endpoint !== draft.ollamaFetched.trim()) return undefined
        return {choice: {...base, model, ollamaEndpoint: endpoint || null}}
    }
    if (isCloudProvider(provider)) {
        const apiKey = context.apiKey.trim()
        if (!apiKey) return undefined
        if (provider !== 'claude') return {choice: {...base, model, apiKey}}
        const tokens = parseSummaryLength(draft.maxLength, claudeOutputMaximum(model))
        return tokens === undefined ? undefined : {choice: {...base, model, apiKey, summaryMaxTokens: tokens}}
    }
    return undefined
}
