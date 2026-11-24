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
import {queryOptions} from '@tanstack/react-query'
import {useEffect} from 'react'
import {create} from 'zustand'
import {persist, type PersistStorage} from 'zustand/middleware'
import {DETECT_LANGUAGE, normaliseSummaryLanguage} from '@/lib/languages'
import {command} from './core'

interface StoredValue<T> {
    value: T
    set: (value: T) => void
}

// Storage can be unavailable in a locked-down webview; the value then just
// isn't remembered.
function safely<T>(action: () => T): T | null {
    try {
        return action()
    } catch {
        return null
    }
}

/**
 * A value kept under `key` in the old app's format: `read` turns what is
 * stored (null when nothing is) into the value, `write` the value into what
 * to store (null removes the key). Never Zustand's `{state, version}` JSON,
 * which the old UI could not have written (UI_ARCHITECTURE.md, Native data).
 */
function storedValue<T>(key: string, read: (stored: string | null) => T, write: (value: T) => string | null) {
    const storage: PersistStorage<Pick<StoredValue<T>, 'value'>> = {
        getItem: (name) => ({state: {value: read(safely(() => localStorage.getItem(name)))}, version: 0}),
        setItem: (name, {state}) => {
            const stored = write(state.value)
            safely(() => (stored === null ? localStorage.removeItem(name) : localStorage.setItem(name, stored)))
        },
        removeItem: (name) => {
            safely(() => localStorage.removeItem(name))
        },
    }
    return create<StoredValue<T>>()(
        persist(
            (set) => ({
                value: read(null),
                set: (value) => set({value}),
            }),
            {name: key, storage, partialize: ({value}) => ({value})},
        ),
    )
}

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

/** Puts a language first in the recent list, dropping the oldest past the limit. */
export function addRecentSummaryLanguage(code: string) {
    const language = normaliseSummaryLanguage(code)
    if (!language) return
    const {value: recents, set} = useRecentSummaryLanguagesStore.getState()
    set([language, ...recents.filter((recent) => recent !== language)].slice(0, MAX_RECENT_SUMMARY_LANGUAGES))
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
    if (language && !useRecentSummaryLanguagesStore.getState().value.includes(language)) {
        addRecentSummaryLanguage(language)
    }
    useSummaryLanguageStore.getState().set(language)
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

export const SUMMARY_PROVIDERS: readonly {id: SummaryProvider; label: string; needsApiKey: boolean}[] = [
    {id: 'builtin-ai', label: 'Built-in AI', needsApiKey: false},
    {id: 'claude', label: 'Claude', needsApiKey: true},
    {id: 'openai', label: 'OpenAI', needsApiKey: true},
    {id: 'groq', label: 'Groq', needsApiKey: true},
    {id: 'openrouter', label: 'OpenRouter', needsApiKey: true},
    {id: 'ollama', label: 'Ollama', needsApiKey: false},
    {id: 'custom-openai', label: 'Custom server', needsApiKey: false},
]

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
}

/** Null until anything was saved: first launch saves built-in AI. */
export const getSummaryModelConfig = () => command<SummaryModelConfig | null>('api_get_model_config')

/**
 * The summary model. Its page (#117) saves it with `api_save_model_config`
 * and invalidates `preferenceKeys.summaryModel()`.
 */
export const summaryModelQuery = queryOptions({
    queryKey: preferenceKeys.summaryModel(),
    queryFn: getSummaryModelConfig,
})
