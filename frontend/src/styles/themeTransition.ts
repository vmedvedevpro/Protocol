import {flushSync} from 'react-dom'

/**
 * The theme switch's `view-transition-name`. GlobalStyle shows it only live:
 * its thumb is already sliding, and an old snapshot would freeze a second
 * thumb on the previous option.
 */
export const THEME_SWITCH_TRANSITION_NAME = 'theme-switch'

/**
 * Applies a theme change. Where the webview has View Transitions, the old
 * window crossfades into the new one over `durations.base` (`flushSync`
 * paints the new theme inside the callback); only opacity changes, so it
 * stays on under reduced motion. Clicks made during those 200 ms are lost:
 * hit testing skips whatever a transition captured, and a theme change
 * captures the whole window. Elsewhere (WebKitGTK may lack them) the theme
 * switches at once: fading each colour on its own would drag muted text
 * through the background's grey. The switch, an OS switch in system mode and
 * a change from the other window all come through here.
 */
export function changeThemeSmoothly(apply: () => void) {
    if (typeof document.startViewTransition !== 'function') {
        apply()
        return
    }
    document.startViewTransition(() => flushSync(apply))
}
