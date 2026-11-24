/**
 * Runs a storage call that can throw: localStorage can be unavailable in a
 * locked-down webview. The value then just isn't remembered; null stands in
 * for what the call would have returned.
 */
export function safely<T>(action: () => T): T | null {
    try {
        return action()
    } catch {
        return null
    }
}
