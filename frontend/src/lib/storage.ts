import {create} from 'zustand'
import {persist, type PersistStorage} from 'zustand/middleware'

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

export interface StoredValue<T> {
    value: T
    set: (value: T) => void
}

/**
 * A value kept under `key` in the old app's format: `read` turns what is
 * stored (null when nothing is) into the value, `write` the value into what
 * to store (null removes the key). Never Zustand's `{state, version}` JSON,
 * which the old UI could not have written (UI_ARCHITECTURE.md, Native data).
 */
export function storedValue<T>(key: string, read: (stored: string | null) => T, write: (value: T) => string | null) {
    const storage: PersistStorage<Pick<StoredValue<T>, 'value'>> = {
        getItem: (name) => ({state: {value: read(safely(() => localStorage.getItem(name)))}, version: 0}),
        setItem: (name, {state}) => {
            const stored = write(state.value)
            safely(() => (stored === null ? localStorage.removeItem(name) : localStorage.setItem(name, stored)))
        },
        removeItem: (name) => {
            safely(() => localStorage.removeItem(name))
        },
    }
    return create<StoredValue<T>>()(
        persist(
            (set) => ({
                value: read(null),
                set: (value) => set({value}),
            }),
            {name: key, storage, partialize: ({value}) => ({value})},
        ),
    )
}
