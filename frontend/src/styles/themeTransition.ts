import {flushSync} from 'react-dom'
import {durations} from './motion'

/** Set on <html> while the fallback crossfade runs; GlobalStyle reads it. */
export const THEME_TRANSITION_ATTRIBUTE = 'data-theme-transition'

let fallbackTimer: number | undefined

/**
 * Applies a theme change as a crossfade instead of a cut.
 *
 * Where the webview has View Transitions (WebView2; WKWebView from Safari 18;
 * WebKitGTK only in recent releases), the old frame fades into the new one,
 * and `flushSync` makes React paint the new theme inside the callback.
 * Elsewhere every element transitions its colours for `durations.slow`
 * (GlobalStyle). Both change only opacity and colour, nothing moves, so they
 * stay on under reduced motion.
 */
export function changeThemeSmoothly(apply: () => void) {
    if (typeof document.startViewTransition === 'function') {
        document.startViewTransition(() => flushSync(apply))
        return
    }

    const root = document.documentElement
    root.setAttribute(THEME_TRANSITION_ATTRIBUTE, '')
    apply()
    window.clearTimeout(fallbackTimer)
    fallbackTimer = window.setTimeout(() => root.removeAttribute(THEME_TRANSITION_ATTRIBUTE), durations.slow)
}
