import {useState} from 'react'

/**
 * Whether a control's thumb or knob lands at once: after a key press on the
 * control, as the menus' highlight does (a thumb trailing the key reads as
 * lag), until the next pointer press brings its spring back. The flag holds
 * in between, so a change from elsewhere follows the last input on the
 * control. Spread `handlers` on the control's root.
 */
export function useInstantOnKey() {
    const [instant, setInstant] = useState(false)
    return {
        instant,
        handlers: {
            onKeyDown: () => setInstant(true),
            onPointerDown: () => setInstant(false),
        },
    }
}
