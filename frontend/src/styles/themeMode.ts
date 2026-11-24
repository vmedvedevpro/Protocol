import {useSyncExternalStore} from 'react'
import {create} from 'zustand'
import {persist, type PersistStorage} from 'zustand/middleware'
import type {ThemeName} from './theme'
import {changeThemeSmoothly} from './themeTransition'

export type ThemeMode = ThemeName | 'system'

export const THEME_MODES: readonly {value: ThemeMode; label: string}[] = [
    {value: 'light', label: 'Light'},
    {value: 'dark', label: 'Dark'},
    {value: 'system', label: 'Match system'},
]

/**
 * The old app's key, holding the mode as a bare string rather than Zustand's
 * JSON, so a choice made before the rewrite survives it. localStorage is
 * shared by the main window and the minibar; the boot script in index.html
 * reads the same key before the first paint.
 */
export const THEME_STORAGE_KEY = 'meetily_theme'

/**
 * Reads a stored value. Nothing stored, or something unknown, follows the OS,
 * as the boot script does; so removing the key resets the mode.
 */
export function readThemeMode(value: string | null): ThemeMode {
    if (value === 'light' || value === 'dark' || value === 'system') return value
    // Stored before #96, when the old app had three named themes.
    if (value === 'vanilla') return 'light'
    if (value === 'midnight' || value === 'charcoal') return 'dark'
    return 'system'
}

interface ThemeModeState {
    mode: ThemeMode
    setMode: (mode: ThemeMode) => void
}

type PersistedThemeMode = Pick<ThemeModeState, 'mode'>

// Storage can be unavailable in a locked-down webview; the theme then just
// isn't remembered.
function safely<T>(action: () => T): T | null {
    try {
        return action()
    } catch {
        return null
    }
}

const bareStringStorage: PersistStorage<PersistedThemeMode> = {
    getItem: (name) => ({state: {mode: readThemeMode(safely(() => localStorage.getItem(name)))}, version: 0}),
    setItem: (name, value) => {
        safely(() => localStorage.setItem(name, value.state.mode))
    },
    removeItem: (name) => {
        safely(() => localStorage.removeItem(name))
    },
}

export const useThemeModeStore = create<ThemeModeState>()(
    persist(
        (set) => ({
            mode: 'system',
            setMode: (mode) => set({mode}),
        }),
        {
            name: THEME_STORAGE_KEY,
            storage: bareStringStorage,
            partialize: ({mode}) => ({mode}),
        },
    ),
)

// One query object for the page: useSyncExternalStore reads the snapshot on
// every render. Created on first use, not on import, so tests can install
// their matchMedia first.
let darkQuery: MediaQueryList | undefined
const systemDarkQuery = () => (darkQuery ??= window.matchMedia('(prefers-color-scheme: dark)'))

function subscribeToSystemTheme(onChange: () => void) {
    const query = systemDarkQuery()
    // The OS theme shows only in system mode, and there it crossfades like a
    // click on the switch; otherwise nothing visible changes.
    const onSystemChange = () => {
        if (useThemeModeStore.getState().mode === 'system') changeThemeSmoothly(onChange)
        else onChange()
    }
    query.addEventListener('change', onSystemChange)
    return () => query.removeEventListener('change', onSystemChange)
}

const systemIsDark = () => systemDarkQuery().matches

export function resolveThemeMode(mode: ThemeMode, systemDark: boolean): ThemeName {
    if (mode !== 'system') return mode
    return systemDark ? 'dark' : 'light'
}

/** The theme to paint: the chosen one, or the OS one for `system`. */
export function useResolvedTheme(): ThemeName {
    const mode = useThemeModeStore((state) => state.mode)
    const systemDark = useSyncExternalStore(subscribeToSystemTheme, systemIsDark)
    return resolveThemeMode(mode, systemDark)
}
