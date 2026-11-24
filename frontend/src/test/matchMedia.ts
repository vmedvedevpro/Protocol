// jsdom has no matchMedia. This one answers the dark-scheme query from a
// switch the test controls and tells subscribers when it flips.

const DARK_QUERY = '(prefers-color-scheme: dark)'

let systemDark = false
const listeners = new Set<() => void>()

export function setSystemDark(dark: boolean) {
    systemDark = dark
    listeners.forEach((listener) => listener())
}

export function installMatchMedia() {
    systemDark = false
    listeners.clear()
    window.matchMedia = (query: string) => ({
        media: query,
        get matches() {
            return query === DARK_QUERY && systemDark
        },
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        addListener: (listener: () => void) => listeners.add(listener),
        removeListener: (listener: () => void) => listeners.delete(listener),
        dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}
