import {afterEach, describe, expect, it, vi} from 'vitest'
import {durations} from './motion'
import {changeThemeSmoothly, THEME_TRANSITION_ATTRIBUTE} from './themeTransition'

type StartViewTransition = (update: () => void) => unknown

afterEach(() => {
    delete (document as { startViewTransition?: StartViewTransition }).startViewTransition
    document.documentElement.removeAttribute(THEME_TRANSITION_ATTRIBUTE)
    vi.useRealTimers()
})

describe('changeThemeSmoothly', () => {
    it('applies the change inside a view transition where the webview has them', () => {
        const startViewTransition = vi.fn<StartViewTransition>((update) => update())
        Object.assign(document, {startViewTransition})
        const apply = vi.fn()

        changeThemeSmoothly(apply)

        expect(startViewTransition).toHaveBeenCalledOnce()
        expect(apply).toHaveBeenCalledOnce()
        expect(document.documentElement.hasAttribute(THEME_TRANSITION_ATTRIBUTE)).toBe(false)
    })

    it('fades colours for the slow duration where they are missing', () => {
        vi.useFakeTimers()
        const apply = vi.fn()

        changeThemeSmoothly(apply)

        expect(apply).toHaveBeenCalledOnce()
        expect(document.documentElement.hasAttribute(THEME_TRANSITION_ATTRIBUTE)).toBe(true)
        vi.advanceTimersByTime(durations.slow)
        expect(document.documentElement.hasAttribute(THEME_TRANSITION_ATTRIBUTE)).toBe(false)
    })
})
