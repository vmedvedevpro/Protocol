import type {Offer, UpdaterSnapshot} from '@/api/updater'

/** The offer Home announces: downloaded, verified and installable from the app. */
export function readyOffer(snapshot: UpdaterSnapshot | undefined): Offer | null {
    const offer = snapshot?.offer
    return offer?.downloaded && !offer.manualOnly ? offer : null
}

/**
 * Versions a toast was already shown for, across restarts: `{"<kind>:<version>": true}`.
 * **Keep reading** (PARITY.md, localStorage): an old value keeps its toasts shown.
 */
export const SEEN_KEY = 'protocol-updater-seen-v1'

type ToastKind = 'available' | 'ready' | 'updated'

function readSeen(): Record<string, true> {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
        return value && typeof value === 'object' ? value as Record<string, true> : {}
    } catch {
        return {}
    }
}

/** Marks a toast as shown; false when it already was. */
export function claimToast(kind: ToastKind, version: string): boolean {
    const key = `${kind}:${version}`
    const seen = readSeen()
    if (seen[key]) return false
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify({...seen, [key]: true}))
    } catch {
        // Without storage the toast may show again after a restart.
    }
    return true
}
