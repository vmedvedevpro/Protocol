import {act, renderHook} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {settleIpc} from '@/test/ipc'
import {createTestQueryClient} from '@/test/queryClient'
import {
    addRecentSummaryLanguage,
    AUTO_SUMMARY_KEY,
    defaultMeetingLanguage,
    MEETING_LANGUAGE_KEY,
    pinSummaryLanguage,
    removeRecentSummaryLanguage,
    rereadPreferences,
    SUMMARY_LANGUAGE_DEFAULT_KEY,
    SUMMARY_LANGUAGE_RECENTS_KEY,
    summaryModelQuery,
    useAutoSummaryStore,
    useMeetingLanguageStore,
    usePreferencesSync,
    useRecentSummaryLanguagesStore,
    USER_NAME_KEY,
    useSummaryLanguageStore,
    useUserName,
    useUserNameStore,
} from './preferences'

/** What the old UI left in localStorage, read as at startup. */
function stored(values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value)
    rereadPreferences(null)
}

const recents = () => useRecentSummaryLanguagesStore.getState().value
const pinned = () => useSummaryLanguageStore.getState().value

describe('stored preferences', () => {
    it('reads what the old UI saved, under its keys and in its formats', () => {
        stored({
            [USER_NAME_KEY]: ' Tyler ',
            [MEETING_LANGUAGE_KEY]: 'ru',
            [AUTO_SUMMARY_KEY]: 'false',
            [SUMMARY_LANGUAGE_DEFAULT_KEY]: 'pt-BR',
            [SUMMARY_LANGUAGE_RECENTS_KEY]: '["en","ru","xx","en_GB","pt"]',
        })

        expect(renderHook(() => useUserName()).result.current).toBe('Tyler')
        expect(useMeetingLanguageStore.getState().value).toBe('ru')
        expect(useAutoSummaryStore.getState().value).toBe(false)
        expect(pinned()).toBe('pt')
        // Unknown codes go, regional ones become their language, repeats go.
        expect(recents()).toEqual(['en', 'ru', 'pt'])
    })

    it('starts from the old defaults and writes nothing until something changes', () => {
        expect(useUserNameStore.getState().value).toBe('')
        expect(useAutoSummaryStore.getState().value).toBe(true)
        expect(pinned()).toBeNull()
        expect(recents()).toEqual([])
        expect(localStorage.length).toBe(0)
    })

    it('defaults the meeting language to English on an English system, to detection otherwise', () => {
        expect(defaultMeetingLanguage('en-US')).toBe('en')
        expect(defaultMeetingLanguage('ru-RU')).toBe('auto')
        expect(defaultMeetingLanguage('pt_BR')).toBe('auto')
    })

    it('writes each value back in the old format', () => {
        useUserNameStore.getState().set('Tyler ')
        useMeetingLanguageStore.getState().set('de')
        useAutoSummaryStore.getState().set(false)
        pinSummaryLanguage('ru')

        expect(localStorage.getItem(USER_NAME_KEY)).toBe('Tyler ')
        expect(localStorage.getItem(MEETING_LANGUAGE_KEY)).toBe('de')
        expect(localStorage.getItem(AUTO_SUMMARY_KEY)).toBe('false')
        expect(localStorage.getItem(SUMMARY_LANGUAGE_DEFAULT_KEY)).toBe('ru')
        expect(localStorage.getItem(SUMMARY_LANGUAGE_RECENTS_KEY)).toBe('["ru"]')

        pinSummaryLanguage(null)
        expect(localStorage.getItem(SUMMARY_LANGUAGE_DEFAULT_KEY)).toBeNull()
    })
})

describe('summary language', () => {
    it('puts a newly pinned language on the recent list and leaves a listed one in place', () => {
        stored({[SUMMARY_LANGUAGE_RECENTS_KEY]: '["en","ru"]'})

        pinSummaryLanguage('ru')
        expect(recents()).toEqual(['en', 'ru'])

        pinSummaryLanguage('de')
        expect(pinned()).toBe('de')
        expect(recents()).toEqual(['de', 'en', 'ru'])
    })

    it('ignores a language summaries cannot be written in', () => {
        pinSummaryLanguage('ru')
        pinSummaryLanguage('xx')
        addRecentSummaryLanguage('xx')

        expect(pinned()).toBe('ru')
        expect(recents()).toEqual(['ru'])
    })

    it('keeps the five newest and unpins a language taken off the list', () => {
        for (const code of ['en', 'ru', 'de', 'fr', 'es', 'it']) addRecentSummaryLanguage(code)
        expect(recents()).toEqual(['it', 'es', 'fr', 'de', 'ru'])

        pinSummaryLanguage('fr')
        removeRecentSummaryLanguage('fr')

        expect(recents()).toEqual(['it', 'es', 'de', 'ru'])
        expect(pinned()).toBeNull()
    })
})

describe('usePreferencesSync', () => {
    it('sends the meeting language to native at startup and on every change', async () => {
        stored({[MEETING_LANGUAGE_KEY]: 'ru'})

        renderHook(() => usePreferencesSync())
        await settleIpc()
        expect(mockState.preferences.languagePreference).toBe('ru')

        act(() => useMeetingLanguageStore.getState().set('auto'))
        await settleIpc()
        expect(mockState.preferences.languagePreference).toBe('auto')
    })

    it('reads a change made in the other window', () => {
        renderHook(() => usePreferencesSync())

        // The minibar saved it; this window hears a storage event.
        localStorage.setItem(USER_NAME_KEY, 'Priya')
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', {key: USER_NAME_KEY}))
        })

        expect(useUserNameStore.getState().value).toBe('Priya')
    })
})

describe('summaryModelQuery', () => {
    it('reads the saved model, and null on a database with none', async () => {
        const client = createTestQueryClient()
        expect(await client.fetchQuery(summaryModelQuery)).toMatchObject({provider: 'builtin-ai', model: 'qwen3.5:4b'})

        mockState.preferences.summaryModel = null
        expect(await client.fetchQuery({...summaryModelQuery, staleTime: 0})).toBeNull()
    })
})
