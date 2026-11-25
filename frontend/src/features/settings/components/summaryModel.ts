import type {SummaryModelConfig, SummaryProvider} from '@/api/preferences'

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
        return {value: model ? `Built-in · ${model}` : provider.label}
    }
    const value = config.model ? `${provider.label} · ${config.model}` : provider.label
    return provider.needsApiKey && !config.apiKey ? {value, description: 'Needs an API key'} : {value}
}
