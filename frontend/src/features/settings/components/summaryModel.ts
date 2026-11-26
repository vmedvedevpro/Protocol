import type {SummaryModelConfig} from '@/api/preferences'
import {shortModelName, SUMMARY_PROVIDERS} from '@/api/summaryProviders'

/**
 * What the summary model row says: the provider and its model, and what it
 * still needs. `builtInName` is the built-in model's display name, once known.
 */
export function describeSummaryModel(
    config: SummaryModelConfig | null,
    builtInName?: string,
): {value: string; description?: string} {
    // Nothing saved yet, or a provider this version no longer offers ('').
    const provider = config?.provider ? SUMMARY_PROVIDERS[config.provider] : undefined
    if (!config || !provider) return {value: 'Not chosen'}
    if (config.provider === 'builtin-ai') {
        const model = builtInName ? shortModelName(builtInName) : config.model
        return {value: model ? `Built-in (${model})` : provider.label}
    }
    const value = config.model ? `${provider.label} (${config.model})` : provider.label
    return provider.needsApiKey && !config.apiKey ? {value, description: 'Needs an API key'} : {value}
}
