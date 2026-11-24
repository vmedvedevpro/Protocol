import {afterEach, describe, expect, it, vi} from 'vitest'
import {durations} from './motion'
import {changeThemeSmoothly, THEME_TRANSITION_ATTRIBUTE} from './themeTransition'

afterEach(() => {
    document.documentElement.removeAttribute(THEME_TRANSITION_ATTRIBUTE)
    vi.useRealTimers()
})

describe('changeThemeSmoothly', () => {
    it('fades colours for the slow duration around the change', () => {
        vi.useFakeTimers()
        const fading: boolean[] = []
        const apply = vi.fn(() => fading.push(document.documentElement.hasAttribute(THEME_TRANSITION_ATTRIBUTE)))

        changeThemeSmoothly(apply)

        expect(fading).toEqual([true])
        vi.advanceTimersByTime(durations.slow - 1)
        expect(document.documentElement.hasAttribute(THEME_TRANSITION_ATTRIBUTE)).toBe(true)
        vi.advanceTimersByTime(1)
        expect(document.documentElement.hasAttribute(THEME_TRANSITION_ATTRIBUTE)).toBe(false)
    })
})
