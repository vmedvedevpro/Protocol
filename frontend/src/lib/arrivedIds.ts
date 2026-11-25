import {useState} from 'react'

interface Seen {
    shown: ReadonlySet<string>
    arrived: ReadonlySet<string>
}

const NONE: ReadonlySet<string> = new Set()

/**
 * The ids of a list's rows that arrived after it first showed, for the rows
 * that rise under a veil (Veil) while the first ones arrive with the screen.
 * A row arrives when its id was not in the list the render before: one added
 * later, or one that comes back (Undo). The set only grows, so a row keeps
 * its arrival for its whole life and stays the same element. `ids` is
 * undefined until the list has loaded; while `track` is false the list
 * changes without anything arriving (a transcript replaced after Stop).
 */
export function useArrivedIds(ids: readonly string[] | undefined, track = true): ReadonlySet<string> {
    const [seen, setSeen] = useState<Seen | null>(() => (ids ? {shown: new Set(ids), arrived: NONE} : null))
    if (ids && (!seen || ids.length !== seen.shown.size || ids.some((id) => !seen.shown.has(id)))) {
        const fresh = seen && track ? ids.filter((id) => !seen.shown.has(id)) : []
        const arrived = fresh.length > 0 ? new Set([...(seen?.arrived ?? []), ...fresh]) : seen?.arrived ?? NONE
        // Set while rendering: React renders again at once, before anything is drawn.
        setSeen({shown: new Set(ids), arrived})
    }
    return seen?.arrived ?? NONE
}
