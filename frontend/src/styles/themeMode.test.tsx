import {act, renderHook} from '@testing-library/react'
import {afterEach, describe, expect, it} from 'vitest'
import {setSystemDark} from '@/test/matchMedia'
import {readThemeMode, THEME_STORAGE_KEY, useResolvedTheme, useThemeModeStore} from './themeMode'
import {THEME_TRANSITION_ATTRIBUTE} from './themeTransition'

afterEach(() => {
    document.documentElement.removeAttribute(THEME_TRANSITION_ATTRIBUTE)
})

describe('theme mode', () => {
    it('reads what the old app stored, including the names from before #96', () => {
        expect(readThemeMode('light')).toBe('light')
        expect(readThemeMode('dark')).toBe('dark')
        expect(readThemeMode('system')).toBe('system')
        expect(readThemeMode('vanilla')).toBe('light')
        expect(readThemeMode('midnight')).toBe('dark')
        expect(readThemeMode('charcoal')).toBe('dark')
        expect(readThemeMode('sepia')).toBe('system')
        expect(readThemeMode(null)).toBe('system')
    })

    it('restores the mode from the old key', async () => {
        localStorage.setItem(THEME_STORAGE_KEY, 'midnight')

        await useThemeModeStore.persist.rehydrate()

        expect(useThemeModeStore.getState().mode).toBe('dark')
    })

    it('saves the mode as a bare string, the format the old app and the boot script read', () => {
        useThemeModeStore.getState().setMode('light')

        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    })

    it('follows the OS when the stored value is unknown or gone', async () => {
        useThemeModeStore.getState().setMode('dark')
        localStorage.setItem(THEME_STORAGE_KEY, '{"state":{"mode":"dark"}}')
        await useThemeModeStore.persist.rehydrate()
        expect(useThemeModeStore.getState().mode).toBe('system')

        useThemeModeStore.getState().setMode('dark')
        localStorage.removeItem(THEME_STORAGE_KEY)
        await useThemeModeStore.persist.rehydrate()
        expect(useThemeModeStore.getState().mode).toBe('system')
        // Reading writes nothing back.
        expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    })

    it('follows the OS for system, including a switch while the app is open', () => {
        const {result} = renderHook(() => useResolvedTheme())
        expect(result.current).toBe('light')

        act(() => setSystemDark(true))
        expect(result.current).toBe('dark')

        act(() => useThemeModeStore.getState().setMode('light'))
        expect(result.current).toBe('light')
    })

    it('fades an OS switch in system mode, and only there', () => {
        const fading = () => document.documentElement.hasAttribute(THEME_TRANSITION_ATTRIBUTE)
        const {result} = renderHook(() => useResolvedTheme())

        act(() => setSystemDark(true))
        expect(result.current).toBe('dark')
        expect(fading()).toBe(true)

        act(() => useThemeModeStore.getState().setMode('light'))
        document.documentElement.removeAttribute(THEME_TRANSITION_ATTRIBUTE)
        act(() => setSystemDark(false))
        expect(fading()).toBe(false)
    })
})
