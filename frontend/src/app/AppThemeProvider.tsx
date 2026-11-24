import {type ReactNode, useEffect} from 'react'
import {ThemeProvider} from 'styled-components'
import {setWindowTheme} from '@/api/window'
import {GlobalStyle} from '@/styles/GlobalStyle'
import {themes} from '@/styles/theme'
import {THEME_STORAGE_KEY, useResolvedTheme, useThemeModeStore} from '@/styles/themeMode'
import {changeThemeSmoothly} from '@/styles/themeTransition'

/** Paints the chosen theme and keeps the native window and the other window in step. */
export function AppThemeProvider({children}: { children: ReactNode }) {
    const mode = useThemeModeStore((state) => state.mode)
    const theme = useResolvedTheme()

    // The boot script in index.html set color-scheme inline, which would
    // outrank GlobalStyle's from now on.
    useEffect(() => {
        document.documentElement.style.removeProperty('color-scheme')
    }, [])

    // The main window and the minibar share localStorage: a change in one
    // arrives in the other as a storage event. A removed key (or a cleared
    // storage, key null) reads as `system`; rehydrating writes nothing back.
    // It crossfades like a click on the switch; the storage is synchronous,
    // so the new mode lands inside the transition's update.
    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key !== THEME_STORAGE_KEY && event.key !== null) return
            changeThemeSmoothly(() => void useThemeModeStore.persist.rehydrate())
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    useEffect(() => {
        setWindowTheme(mode === 'system' ? null : mode).catch((error: unknown) =>
            console.warn('Failed to set the window theme:', error),
        )
    }, [mode])

    return (
        <ThemeProvider theme={themes[theme]}>
            <GlobalStyle/>
            {children}
        </ThemeProvider>
    )
}
