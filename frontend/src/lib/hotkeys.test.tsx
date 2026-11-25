import {render} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {matchesHotkey, registerHotkey, useHotkey} from './hotkeys'

const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init})
    document.body.dispatchEvent(event)
    return event
}

describe('matchesHotkey', () => {
    it('reads ⌘ as the modifier on macOS and Ctrl elsewhere', () => {
        const combo = {code: 'KeyR', mod: true}
        const cmd = new KeyboardEvent('keydown', {code: 'KeyR', metaKey: true})
        const ctrl = new KeyboardEvent('keydown', {code: 'KeyR', ctrlKey: true})

        expect(matchesHotkey(combo, cmd, 'macos')).toBe(true)
        expect(matchesHotkey(combo, ctrl, 'macos')).toBe(false)
        expect(matchesHotkey(combo, ctrl, 'windows')).toBe(true)
        expect(matchesHotkey(combo, cmd, 'linux')).toBe(false)
    })

    it('wants exactly its modifiers, and never AltGr', () => {
        const combo = {code: 'KeyR', mod: true}

        expect(matchesHotkey(combo, new KeyboardEvent('keydown', {code: 'KeyR', ctrlKey: true, shiftKey: true}), 'windows')).toBe(false)
        expect(matchesHotkey(combo, new KeyboardEvent('keydown', {code: 'KeyR', ctrlKey: true, altKey: true}), 'windows')).toBe(false)
        expect(matchesHotkey({code: 'Space'}, new KeyboardEvent('keydown', {code: 'Space', ctrlKey: true}), 'windows')).toBe(false)
    })
})

describe('registerHotkey', () => {
    it('runs the screen hotkey over the app one on the same keys, and the app one again without it', () => {
        const app = vi.fn()
        const screen = vi.fn()
        const stopApp = registerHotkey({code: 'KeyR', mod: true}, app, 'app')
        const stopScreen = registerHotkey({code: 'KeyR', mod: true}, screen)

        const event = press({code: 'KeyR', key: 'к', ctrlKey: true})
        expect(screen).toHaveBeenCalledTimes(1)
        expect(app).not.toHaveBeenCalled()
        // Ctrl R must not reach the webview, which would reload the page.
        expect(event.defaultPrevented).toBe(true)

        stopScreen()
        press({code: 'KeyR', ctrlKey: true})
        expect(app).toHaveBeenCalledTimes(1)
        stopApp()
    })

    it('keeps Ctrl R from reloading the page while no hotkey is registered', () => {
        // As during startup and first launch, before the shell registers its ⌘R.
        expect(press({code: 'KeyR', ctrlKey: true}).defaultPrevented).toBe(true)
        expect(press({code: 'KeyK', ctrlKey: true}).defaultPrevented).toBe(false)
    })

    it('runs the latest registration within a level', () => {
        const first = vi.fn()
        const second = vi.fn()
        const stopFirst = registerHotkey({code: 'Space'}, first)
        const stopSecond = registerHotkey({code: 'Space'}, second)

        press({code: 'Space'})

        expect(second).toHaveBeenCalledTimes(1)
        expect(first).not.toHaveBeenCalled()
        stopFirst()
        stopSecond()
    })

    it('leaves a bare key to the focused control and to an open dialog', async () => {
        const run = vi.fn()
        const stop = registerHotkey({code: 'Space'}, run)
        render(
            <>
                <input aria-label="Title"/>
                <button type="button">Pause</button>
            </>,
        )

        await userEvent.click(document.querySelector('input')!)
        await userEvent.keyboard(' ')
        await userEvent.click(document.querySelector('button')!)
        await userEvent.keyboard(' ')
        expect(run).not.toHaveBeenCalled()

        const dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        document.body.append(dialog)
        const event = press({code: 'Space'})
        expect(run).not.toHaveBeenCalled()
        expect(event.defaultPrevented).toBe(false)

        dialog.remove()
        press({code: 'Space'})
        expect(run).toHaveBeenCalledTimes(1)
        stop()
    })

    it('blocks ⌘ hotkeys while a dialog is open or the key repeats, without letting them through', () => {
        const run = vi.fn()
        const stop = registerHotkey({code: 'KeyR', mod: true}, run)
        const dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        document.body.append(dialog)

        expect(press({code: 'KeyR', ctrlKey: true}).defaultPrevented).toBe(true)
        dialog.remove()
        expect(press({code: 'KeyR', ctrlKey: true, repeat: true}).defaultPrevented).toBe(true)
        expect(run).not.toHaveBeenCalled()
        stop()
    })

    it('fires a ⌘ hotkey from a text field', async () => {
        const run = vi.fn()
        const stop = registerHotkey({code: 'Comma', mod: true}, run)
        render(<input aria-label="Search"/>)

        await userEvent.click(document.querySelector('input')!)
        await userEvent.keyboard('{Control>}[Comma]{/Control}')

        expect(run).toHaveBeenCalledTimes(1)
        stop()
    })
})

describe('useHotkey', () => {
    function Pause({onPause, enabled}: { onPause: () => void, enabled: boolean }) {
        useHotkey({code: 'Space'}, onPause, {enabled})
        return null
    }

    it('calls the latest handler while mounted and enabled', () => {
        const first = vi.fn()
        const latest = vi.fn()
        const {rerender, unmount} = render(<Pause onPause={first} enabled/>)

        rerender(<Pause onPause={latest} enabled/>)
        press({code: 'Space'})
        expect(latest).toHaveBeenCalledTimes(1)
        expect(first).not.toHaveBeenCalled()

        rerender(<Pause onPause={latest} enabled={false}/>)
        press({code: 'Space'})
        unmount()
        press({code: 'Space'})
        expect(latest).toHaveBeenCalledTimes(1)
    })
})
