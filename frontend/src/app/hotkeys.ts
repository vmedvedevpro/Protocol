import {useEffect, useEffectEvent} from 'react'
import {platform, type Platform} from '@/lib/platform'

/**
 * The window's keyboard shortcuts: one keydown listener and the hotkeys that
 * screens and the shell register with `useHotkey`. The rules, Space's
 * included, are in docs/UI_ARCHITECTURE.md › Window shell › Hotkeys.
 */

export interface HotkeyCombo {
    /**
     * `KeyboardEvent.code`: the physical key (`KeyR`, `Comma`, `Space`), so
     * Ctrl R stays Ctrl R on a Russian layout, where `key` would be `к`.
     */
    code: string
    /** ⌘ on macOS, Ctrl elsewhere; hints write it with `formatShortcut`. */
    mod?: boolean
    shift?: boolean
}

/**
 * `app`: the shell's defaults, such as ⌘R starting a recording. A `screen`
 * hotkey (the default) is registered by a screen or a part of one, and wins
 * over an `app` one on the same keys: the recording screen's ⌘R stops the
 * recording. Within a level the latest registration wins.
 */
export type HotkeyLevel = 'app' | 'screen'

interface Registration extends HotkeyCombo {
    level: HotkeyLevel
    order: number
    run: (event: KeyboardEvent) => void
}

const registrations = new Set<Registration>()
let registered = 0

// A key without ⌘/Ctrl belongs to the focused control first: Space presses a
// button, toggles a switch, types into a field.
const OWNS_BARE_KEYS = [
    'input', 'textarea', 'select', 'button', 'a[href]', 'summary',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]', '[role="checkbox"]', '[role="switch"]', '[role="radio"]', '[role="tab"]',
    '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="option"]',
    '[role="slider"]', '[role="textbox"]', '[role="combobox"]',
].join(', ')

// While a sheet is open the window behind it takes no shortcuts.
const OPEN_DIALOG = '[role="dialog"], [role="alertdialog"]'

/** Whether `event` presses `combo` on platform `on`: the same key, and exactly its modifiers. */
export function matchesHotkey(combo: HotkeyCombo, event: KeyboardEvent, on: Platform = platform): boolean {
    if (event.code !== combo.code) return false
    const mod = on === 'macos' ? event.metaKey : event.ctrlKey
    const other = on === 'macos' ? event.ctrlKey : event.metaKey
    // Alt too: AltGr on Windows reports Ctrl and Alt together, and types characters.
    return !other && !event.altKey && mod === Boolean(combo.mod) && event.shiftKey === Boolean(combo.shift)
}

const rank = (registration: Registration) => (registration.level === 'screen' ? 1 : 0)

function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return
    const bareKeysTaken = event.target instanceof Element && event.target.closest(OWNS_BARE_KEYS) !== null

    let winner: Registration | undefined
    for (const registration of registrations) {
        if (!matchesHotkey(registration, event)) continue
        if (!registration.mod && bareKeysTaken) continue
        if (!winner || rank(registration) > rank(winner)
            || (rank(registration) === rank(winner) && registration.order > winner.order)) {
            winner = registration
        }
    }
    if (!winner) return

    const dialogOpen = document.querySelector(OPEN_DIALOG) !== null
    // A bare key is the dialog's: Space presses its focused button.
    if (!winner.mod && dialogOpen) return
    // Ctrl R would also reload the page in the webview, held down or not.
    event.preventDefault()
    if (event.repeat || dialogOpen) return
    winner.run(event)
}

/**
 * Registers a hotkey outside React; returns the function that removes it.
 * Components use `useHotkey`.
 */
export function registerHotkey(
    combo: HotkeyCombo,
    run: (event: KeyboardEvent) => void,
    level: HotkeyLevel = 'screen',
): () => void {
    if (registrations.size === 0) window.addEventListener('keydown', onKeyDown)
    const registration: Registration = {...combo, level, order: ++registered, run}
    registrations.add(registration)
    return () => {
        registrations.delete(registration)
        if (registrations.size === 0) window.removeEventListener('keydown', onKeyDown)
    }
}

interface HotkeyOptions {
    level?: HotkeyLevel
    /** Off removes the hotkey until it is on again. */
    enabled?: boolean
}

/**
 * Runs `run` on the hotkey while the component is mounted. It always calls
 * the latest `run`; the registration changes only with the keys, the level
 * and `enabled`.
 */
export function useHotkey(
    {code, mod, shift}: HotkeyCombo,
    run: (event: KeyboardEvent) => void,
    {level = 'screen', enabled = true}: HotkeyOptions = {},
) {
    const onRun = useEffectEvent(run)

    useEffect(() => {
        if (!enabled) return
        return registerHotkey({code, mod, shift}, (event) => onRun(event), level)
    }, [code, mod, shift, level, enabled])
}
