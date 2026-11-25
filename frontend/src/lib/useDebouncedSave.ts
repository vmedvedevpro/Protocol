import {useEffect, useEffectEvent, useRef, useState} from 'react'

/** A drag saves once it rests this long, not on every step. */
export const SLIDER_SAVE_MS = 250

/**
 * A slider's value, saved once the drag rests (`ms`) and when the row goes
 * away mid-drag, so leaving the page keeps it. `draft` is the value shown
 * until then; it is cleared after the save, whose mutation has put the value
 * in its query already.
 */
export function useDebouncedSave<T>(save: (value: T) => void, ms = SLIDER_SAVE_MS) {
    const [draft, setDraft] = useState<T | null>(null)
    // The last value not yet written.
    const pending = useRef<T | null>(null)
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
    const flush = () => {
        clearTimeout(timer.current)
        if (pending.current === null) return
        save(pending.current)
        pending.current = null
    }
    const flushOnLeave = useEffectEvent(flush)
    useEffect(() => () => flushOnLeave(), [])

    const change = (value: T) => {
        setDraft(value)
        pending.current = value
        clearTimeout(timer.current)
        timer.current = setTimeout(() => {
            flush()
            setDraft(null)
        }, ms)
    }
    return {draft, change}
}
