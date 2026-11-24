import type {SummaryModelConfig, SummaryProvider} from '@/api/preferences'

/** The providers as the summary model row names them, and which need a key. */
const PROVIDERS: Record<SummaryProvider, {label: string; needsApiKey: boolean}> = {
    'builtin-ai': {label: 'Built-in AI', needsApiKey: false},
    claude: {label: 'Claude', needsApiKey: true},
    openai: {label: 'OpenAI', needsApiKey: true},
    groq: {label: 'Groq', needsApiKey: true},
    openrouter: {label: 'OpenRouter', needsApiKey: true},
    ollama: {label: 'Ollama', needsApiKey: false},
    'custom-openai': {label: 'Custom server', needsApiKey: false},
}

/** A built-in model's name without its tag: "Qwen 3.5 4B (High Quality)" is "Qwen 3.5 4B". */
const shortModelName = (displayName: string) => displayName.replace(/\s*\([^)]*\)\s*$/, '')

/**
 * What the summary model row says: the provider and its model, and what it
 * still needs. `builtInName` is the built-in model's display name, once known.
 */
export function describeSummaryModel(
    config: SummaryModelConfig | null,
    builtInName?: string,
): {value: string; description?: string} {
    // Nothing saved yet, or a provider this version no longer offers ('').
    const provider = config?.provider ? PROVIDERS[config.provider] : undefined
    if (!config || !provider) return {value: 'Not chosen', description: 'Choose one to write summaries'}
    if (config.provider === 'builtin-ai') {
        const model = builtInName ? shortModelName(builtInName) : config.model
        return {value: model ? `Built-in · ${model}` : provider.label}
    }
    const value = config.model ? `${provider.label} · ${config.model}` : provider.label
    return provider.needsApiKey && !config.apiKey ? {value, description: 'Needs an API key'} : {value}
}
