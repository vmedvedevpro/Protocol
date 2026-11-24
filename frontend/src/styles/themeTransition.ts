import {durations} from './motion'

/** Set on <html> while a theme change fades; GlobalStyle reads it. */
export const THEME_TRANSITION_ATTRIBUTE = 'data-theme-transition'

let fadeTimer: number | undefined

/**
 * Applies a theme change as a colour fade instead of a cut: while the
 * attribute is on, every element transitions its colours for
 * `durations.slow` (GlobalStyle). Nothing moves, so it stays on under reduced
 * motion. The switch, an OS switch in system mode and a change from the other
 * window all come through here.
 *
 * Not View Transitions: while one runs, the whole window is a snapshot and
 * every click lands on the document element (CSSWG resolution in
 * w3c/csswg-drafts#7797), so clicks made during the fade would be lost.
 */
export function changeThemeSmoothly(apply: () => void) {
    const root = document.documentElement
    root.setAttribute(THEME_TRANSITION_ATTRIBUTE, '')
    apply()
    window.clearTimeout(fadeTimer)
    fadeTimer = window.setTimeout(() => root.removeAttribute(THEME_TRANSITION_ATTRIBUTE), durations.slow)
}
