import {afterEach, describe, expect, it} from 'vitest'
import {setSystemDark} from '@/test/matchMedia'
import indexHtml from '../../index.html?raw'
import {readThemeMode, resolveThemeMode, THEME_STORAGE_KEY} from './themeMode'

// The boot script in index.html runs before the bundle, so it cannot import
// themeMode.ts and repeats its key and values. Running it on every stored
// value keeps the two in step.
const bootScript = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? ''

const STORED = [null, 'light', 'dark', 'system', 'vanilla', 'midnight', 'charcoal', 'sepia']
const CASES = STORED.flatMap((stored) => [false, true].map((systemDark) => ({stored, systemDark})))

afterEach(() => {
    document.documentElement.style.removeProperty('color-scheme')
})

describe('theme boot script', () => {
    it.each(CASES)('paints what themeMode.ts resolves for $stored when the OS is dark: $systemDark', ({stored, systemDark}) => {
        if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, stored)
        setSystemDark(systemDark)

        new Function(bootScript)()

        expect(document.documentElement.style.colorScheme).toBe(resolveThemeMode(readThemeMode(stored), systemDark))
    })
})
