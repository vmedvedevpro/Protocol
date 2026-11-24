import {afterEach, describe, expect, it, vi} from 'vitest'
import {changeThemeSmoothly} from './themeTransition'

type StartViewTransition = (update: () => void) => unknown

afterEach(() => {
    delete (document as { startViewTransition?: StartViewTransition }).startViewTransition
})

describe('changeThemeSmoothly', () => {
    it('applies the change inside a view transition where the webview has them', () => {
        const startViewTransition = vi.fn<StartViewTransition>((update) => update())
        Object.assign(document, {startViewTransition})
        const apply = vi.fn()

        changeThemeSmoothly(apply)

        expect(startViewTransition).toHaveBeenCalledOnce()
        expect(apply).toHaveBeenCalledOnce()
    })

    it('applies it at once where they are missing', () => {
        const apply = vi.fn()

        changeThemeSmoothly(apply)

        expect(apply).toHaveBeenCalledOnce()
    })
})
