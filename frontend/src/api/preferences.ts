/**
 * The user's preferences that several screens read: their name, the meeting
 * language, the automatic summary, the summary language and the summary
 * model. All but the model live in localStorage under the old UI's keys and
 * in its formats (PARITY.md, Persisted state), so an update keeps them; the
 * model is in the database (`api_get_model_config`).
 *
 * Each stored value is a small Zustand store of its own: persist keeps a
 * store under one key, and each of these has its own key. localStorage is
 * shared by the main window and the minibar; `usePreferencesSync` brings a
 * change made in the other window over and tells native the meeting language.
 */
import {mutationOptions, queryOptions} from '@tanstack/react-query'
import {useEffect} from 'react'
import {DETECT_AND_TRANSLATE, DETECT_LANGUAGE, MEETING_LANGUAGES, normaliseSummaryLanguage} from '@/lib/languages'
import {safely, storedValue} from '@/lib/storage'
import {command} from './core'
import {summaryProviderKeys} from './summaryProviders'

// --- Your name -------------------------------------------------------------

export const USER_NAME_KEY = 'meetily_user_name'

/**
 * The name as typed, spaces included, so a field bound to it keeps them;
 * readers take `useUserName`. It decorates the microphone's lines as
 * "You (name)"; identity still comes from the source, never from the name.
 */
export const useUserNameStore = storedValue(USER_NAME_KEY, (stored) => stored ?? '', (name) => name)

/** The user's name, trimmed; empty when they gave none. */
export const useUserName = () => useUserNameStore((state) => state.value.trim())

// --- Meeting language --------------------------------------------------------

export const MEETING_LANGUAGE_KEY = 'primaryLanguage'

/**
 * Without a saved choice: English when the system speaks English, otherwise
 * detection, as the old UI decided.
 */
export function defaultMeetingLanguage(locale: string = navigator.language): string {
    const primary = (locale || 'en').toLowerCase().split(/[-_]/)[0]
    return primary === 'en' ? 'en' : DETECT_LANGUAGE
}

/**
 * A code of `MEETING_LANGUAGES`. Native keeps it in memory only, so
 * `usePreferencesSync` sends it at startup and on every change. It must not
 * change while a recording runs: the screens that offer it lock it then.
 */
export const useMeetingLanguageStore = storedValue(
    MEETING_LANGUAGE_KEY,
    (stored) => stored || defaultMeetingLanguage(),
    (code) => code,
)

/**
 * What first launch offers (#220, was #201): the choice saved before, as a
 * reinstall that kept the app's storage has; else the system's language
 * (its primary subtag) when Whisper's list has it, else detection. Unlike
 * `defaultMeetingLanguage`, which decides for a user who never chose, a
 * Russian system gets Russian here, since the user sees the choice and can
 * change it before Done.
 */
export function firstLaunchMeetingLanguage(locale: string = navigator.language): string {
    const stored = safely(() => localStorage.getItem(MEETING_LANGUAGE_KEY))
    if (stored) return stored
    const primary = (locale || '').toLowerCase().split(/[-_]/)[0]
    const listed = primary !== DETECT_LANGUAGE && primary !== DETECT_AND_TRANSLATE && MEETING_LANGUAGES.some(({code}) => code === primary)
    return listed ? primary : DETECT_LANGUAGE
}

/** Tells native code the language Whisper transcribes in (`LANGUAGE_PREFERENCE` in lib.rs). */
export const setLanguagePreference = (language: string) => command<void>('set_language_preference', {language})

// --- Automatic summary -------------------------------------------------------

export const AUTO_SUMMARY_KEY = 'isAutoSummary'

/** Write a summary as soon as a recording is saved. On unless turned off. */
export const useAutoSummaryStore = storedValue(
    AUTO_SUMMARY_KEY,
    (stored) => stored === null || stored === 'true',
    (on) => String(on),
)

// --- Summary language --------------------------------------------------------

export const SUMMARY_LANGUAGE_DEFAULT_KEY = 'summaryLanguageDefault'
export const SUMMARY_LANGUAGE_RECENTS_KEY = 'summaryLanguageRecents'
/** The most languages the recent list (and the settings' chips) holds. */
export const MAX_RECENT_SUMMARY_LANGUAGES = 5

/**
 * The pinned summary language, a code of `SUMMARY_LANGUAGES`: every new
 * meeting is summarized in it. Null, the default, writes each summary in the
 * language most of the meeting was spoken in. Change it with
 * `pinSummaryLanguage`, which keeps the recent list in step.
 */
export const useSummaryLanguageStore = storedValue<string | null>(
    SUMMARY_LANGUAGE_DEFAULT_KEY,
    normaliseSummaryLanguage,
    (code) => code,
)

function readRecents(stored: string | null): string[] {
    if (!stored) return []
    const parsed: unknown = safely(() => JSON.parse(stored))
    if (!Array.isArray(parsed)) return []
    const codes: string[] = []
    for (const item of parsed) {
        const code = typeof item === 'string' ? normaliseSummaryLanguage(item) : null
        if (code && !codes.includes(code)) codes.push(code)
        if (codes.length === MAX_RECENT_SUMMARY_LANGUAGES) break
    }
    return codes
}

/**
 * Summary languages used lately, newest first: the language picker's recents
 * and the chips under Summary language. The pinned language is always one of
 * them.
 */
export const useRecentSummaryLanguagesStore = storedValue(SUMMARY_LANGUAGE_RECENTS_KEY, readRecents, (codes) =>
    JSON.stringify(codes),
)

/**
 * Puts a language first in the recent list. Past the limit the oldest
 * language goes, unless it is the pinned one: that one stays on the list.
 */
export function addRecentSummaryLanguage(code: string) {
    const language = normaliseSummaryLanguage(code)
    if (!language) return
    const {value: recents, set} = useRecentSummaryLanguagesStore.getState()
    const pinned = useSummaryLanguageStore.getState().value
    const next = [language, ...recents.filter((recent) => recent !== language)]
    if (next.length > MAX_RECENT_SUMMARY_LANGUAGES) {
        let oldest = next.length - 1
        while (oldest > 0 && next[oldest] === pinned) oldest--
        next.splice(oldest, 1)
    }
    set(next)
}

/** Takes a language off the recent list, and unpins it if it was pinned. */
export function removeRecentSummaryLanguage(code: string) {
    const language = normaliseSummaryLanguage(code) ?? code
    const {value: recents, set} = useRecentSummaryLanguagesStore.getState()
    set(recents.filter((recent) => recent !== language))
    if (useSummaryLanguageStore.getState().value === language) useSummaryLanguageStore.getState().set(null)
}

/**
 * Pins a summary language, or unpins with null. A newly pinned language
 * joins the recent list, so the chips show it pinned; one already there keeps
 * its place.
 */
export function pinSummaryLanguage(code: string | null) {
    const language = code === null ? null : normaliseSummaryLanguage(code)
    if (code !== null && !language) return
    // Pinned first, so adding it to a full list never drops it again.
    useSummaryLanguageStore.getState().set(language)
    if (language && !useRecentSummaryLanguagesStore.getState().value.includes(language)) {
        addRecentSummaryLanguage(language)
    }
}

// --- Keeping windows and native in step --------------------------------------

const STORES_BY_KEY: Record<string, {persist: {rehydrate: () => Promise<void> | void}}> = {
    [USER_NAME_KEY]: useUserNameStore,
    [MEETING_LANGUAGE_KEY]: useMeetingLanguageStore,
    [AUTO_SUMMARY_KEY]: useAutoSummaryStore,
    [SUMMARY_LANGUAGE_DEFAULT_KEY]: useSummaryLanguageStore,
    [SUMMARY_LANGUAGE_RECENTS_KEY]: useRecentSummaryLanguagesStore,
}

/**
 * Reads a stored preference again after something outside this window changed
 * it: `key` names one, null reads them all (as a cleared storage reports).
 */
export function rereadPreferences(key: string | null) {
    const stores = key === null ? Object.values(STORES_BY_KEY) : [STORES_BY_KEY[key]]
    for (const store of stores) void store?.persist.rehydrate()
}

/**
 * Mounted once per window, in App. A change saved in the other window arrives
 * as a storage event and is read again. The meeting language goes to native
 * code at startup and whenever it changes; reading it again from the other
 * window sends it once more, which changes nothing.
 */
export function usePreferencesSync() {
    useEffect(() => {
        const onStorage = (event: StorageEvent) => rereadPreferences(event.key)
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const meetingLanguage = useMeetingLanguageStore((state) => state.value)
    useEffect(() => {
        setLanguagePreference(meetingLanguage).catch((error: unknown) =>
            console.warn('Failed to send the meeting language to native code:', error),
        )
    }, [meetingLanguage])
}

// --- Summary model -----------------------------------------------------------

/** The providers native code offers (`LLMProvider::from_str` in summary/llm_client.rs). */
export type SummaryProvider = 'builtin-ai' | 'claude' | 'openai' | 'groq' | 'openrouter' | 'ollama' | 'custom-openai'

/** Mirrors `ModelConfig` in src-tauri/src/api/api.rs. */
export interface SummaryModelConfig {
    /**
     * A `SummaryProvider`, or '' for a saved provider this build no longer
     * offers: show "Select provider" and never fall back to another one.
     */
    provider: SummaryProvider | ''
    /** The provider's model id; for built-in AI the id `builtin_ai_list_models` names. */
    model: string
    whisperModel: string
    /** The saved key of a cloud provider. */
    apiKey: string | null
    ollamaEndpoint: string | null
    /** Maximum summary length in tokens; null for the model's default. */
    summaryMaxTokens: number | null
}

export const preferenceKeys = {
    all: ['preferences'] as const,
    summaryModel: () => [...preferenceKeys.all, 'summaryModel'] as const,
    apiKey: (provider: SummaryProvider) => [...preferenceKeys.all, 'apiKey', provider] as const,
    customServer: () => [...preferenceKeys.all, 'customServer'] as const,
}

/** Null until anything was saved: first launch saves one only when the user chose it, and a fresh database has none. */
export const getSummaryModelConfig = () => command<SummaryModelConfig | null>('api_get_model_config')

/** The summary model; Settings › Summary model saves it (`saveSummaryModelMutation`). */
export const summaryModelQuery = queryOptions({
    queryKey: preferenceKeys.summaryModel(),
    queryFn: getSummaryModelConfig,
})

/** What `api_save_model_config` takes: the whole choice, replacing the stored one. */
export interface SummaryModelChoice {
    provider: SummaryProvider
    model: string
    /** Stored beside the summary model and read by nothing new; written back as read. */
    whisperModel: string
    /** A cloud provider's key, saved for that provider; native ignores an empty one. */
    apiKey: string | null
    ollamaEndpoint: string | null
    summaryMaxTokens: number | null
}

/**
 * Saves the summary model. Native checks the maximum length (Claude's
 * against `claude-output-limits.json`, others 1 to 64 000) and refuses
 * anything else; a cloud provider's key is kept per provider, so switching
 * back finds it again. The built-in model's sidecar is shut down, so the
 * next summary loads the new choice.
 */
export const saveSummaryModel = ({provider, model, whisperModel, apiKey, ollamaEndpoint, summaryMaxTokens}: SummaryModelChoice) =>
    command<unknown>('api_save_model_config', {provider, model, whisperModel, apiKey, ollamaEndpoint, summaryMaxTokens})

/** The key saved for a provider, '' when none is. */
export const getApiKey = (provider: SummaryProvider) => command<string>('api_get_api_key', {provider})

export const apiKeyQuery = (provider: SummaryProvider) =>
    queryOptions({queryKey: preferenceKeys.apiKey(provider), queryFn: () => getApiKey(provider)})

/** Mirrors `CustomOpenAIConfig` in summary/mod.rs: an OpenAI-compatible server of the user's. */
export interface CustomServerConfig {
    /** The API's base URL, `http://localhost:8000/v1`. */
    endpoint: string
    apiKey: string | null
    model: string
    maxTokens: number | null
    /** 0 to 2. */
    temperature: number | null
    /** 0 to 1. */
    topP: number | null
}

/** Null until a custom server was saved. */
export const getCustomServer = () => command<CustomServerConfig | null>('api_get_custom_openai_config')

export const customServerQuery = queryOptions({queryKey: preferenceKeys.customServer(), queryFn: getCustomServer})

/** Native checks the endpoint starts with http:// or https:// and the model is named. */
export const saveCustomServer = ({endpoint, apiKey, model, maxTokens, temperature, topP}: CustomServerConfig) =>
    command<unknown>('api_save_custom_openai_config', {endpoint, apiKey, model, maxTokens, temperature, topP})

/**
 * Saves the summary model, and first the custom server when that is the
 * provider: the custom server is stored apart, and the model choice names
 * it by its model. Everything else that reads the choice reads it again,
 * and a provider's model list asked with a key typed before the save is
 * asked again with the saved one.
 */
export const saveSummaryModelMutation = mutationOptions({
    mutationFn: async ({choice, customServer}: {choice: SummaryModelChoice, customServer?: CustomServerConfig}) => {
        if (customServer) await saveCustomServer(customServer)
        await saveSummaryModel(choice)
    },
    onSettled: (_reply, _error, _variables, _result, {client}) => Promise.all([
        client.invalidateQueries({queryKey: preferenceKeys.all}),
        client.invalidateQueries({queryKey: summaryProviderKeys.all}),
    ]),
})
