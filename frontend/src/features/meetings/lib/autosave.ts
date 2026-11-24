import {useEffect, useRef, useState} from 'react'
import {useIsMutating} from '@tanstack/react-query'

/** How long typing pauses before an edit is saved. */
export const AUTOSAVE_DELAY_MS = 600

/**
 * Saves the latest value `delay` after the last change, and at once when
 * the component unmounts (switching tabs or meetings), so no edit is lost.
 * `save` is read when the timer fires, never captured stale.
 */
export function useAutosave<T>(save: (value: T) => void, delay = AUTOSAVE_DELAY_MS) {
    const pending = useRef<{ value: T } | null>(null)
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    const saveRef = useRef(save)
    useEffect(() => {
        saveRef.current = save
    })

    const [api] = useState(() => {
        const flush = () => {
            clearTimeout(timer.current)
            const next = pending.current
            pending.current = null
            if (next) saveRef.current(next.value)
        }
        return {
            schedule: (value: T) => {
                pending.current = {value}
                clearTimeout(timer.current)
                timer.current = setTimeout(flush, delay)
            },
            flush,
        }
    })

    useEffect(() => api.flush, [api])
    return api
}

/**
 * Whether a save in `scope` (a mutation's `scope.id`, as `notes:<id>`) is
 * still on its way to native. An editor mounted meanwhile would start from
 * the cached text, older than the save (the #130 review, #113).
 */
export function useSaving(scope: string): boolean {
    return useIsMutating({predicate: (mutation) => mutation.options.scope?.id === scope}) > 0
}
