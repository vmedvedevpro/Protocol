import {create} from 'zustand'

/**
 * What a toast reports. The tone picks its icon and how urgently screen
 * readers hear it; none of them is red, which belongs to the recording.
 * `loading` turns a spinner and stays until the same id is shown again with
 * the outcome.
 */
export type ToastTone = 'message' | 'success' | 'info' | 'warning' | 'error' | 'loading'

export interface ToastAction {
    /** The button's text, such as "Open". */
    label: string
    onClick: () => void
    /**
     * How to do the same without the toast, for screen readers, which may
     * read the toast after it has gone (Radix's `altText`). The label by default.
     */
    altText?: string
}

export interface ToastOptions {
    /**
     * Showing a toast with the id of one still on screen replaces its content
     * where it stands, as a loading toast does with its outcome.
     */
    id?: string
    /** A line under the title. Long words wrap anywhere, so a hash fits. */
    description?: string
    /** One button beside the close button; pressing it also closes the toast. */
    action?: ToastAction
    /**
     * Milliseconds on screen, `TOAST_DURATION_MS` by default and `Infinity`
     * for a loading toast; `Infinity` waits for the user. The time stops while
     * the pointer or focus is on a toast and while the window is in the
     * background, so a long warning (30 s) is not lost behind another window.
     */
    duration?: number
}

export interface ToastData extends ToastOptions {
    id: string
    tone: ToastTone
    title: string
    duration: number
}

export const TOAST_DURATION_MS = 5000

/** Toasts on screen at once; a new one past it closes the oldest. */
export const MAX_TOASTS = 3

interface ToastState {
    /** Newest first. */
    toasts: ToastData[]
    /**
     * What the last in-place replacement said, until the Toaster has
     * announced it. Radix announces a toast when it appears; a loading toast
     * that turns into its outcome stays the same toast, so the Toaster
     * announces the outcome from here. `seq` tells two equal texts apart.
     */
    replaced: {text: string, seq: number} | null
}

/**
 * The window's toasts. Client state: the Toaster (UiProviders) draws it, and
 * anything, a mutation's callback or an event handler outside React, adds to
 * it through `toast`. Each window has its own.
 */
export const useToastStore = create<ToastState>(() => ({toasts: [], replaced: null}))

let lastId = 0
let lastReplacement = 0

function show(tone: ToastTone, title: string, options: ToastOptions = {}): string {
    const id = options.id ?? `toast-${++lastId}`
    const duration = options.duration ?? (tone === 'loading' ? Infinity : TOAST_DURATION_MS)
    const toast: ToastData = {...options, id, tone, title, duration}
    useToastStore.setState(({toasts, replaced}) => toasts.some((shown) => shown.id === id)
        ? {
            toasts: toasts.map((shown) => shown.id === id ? toast : shown),
            replaced: {text: [title, options.description].filter(Boolean).join('. '), seq: ++lastReplacement},
        }
        : {toasts: trim([toast, ...toasts]), replaced})
    return id
}

/**
 * Keeps `MAX_TOASTS`, newest first. The oldest timed toast goes first; a
 * persistent one (`Infinity`, such as "Copy notes") goes only for another
 * persistent one, since it may be the only way back to what it offers.
 */
function trim(toasts: ToastData[]): ToastData[] {
    const kept = [...toasts]
    while (kept.length > MAX_TOASTS) {
        const timed = kept.findLastIndex((shown) => Number.isFinite(shown.duration))
        kept.splice(timed >= 0 ? timed : kept.length - 1, 1)
    }
    return kept
}

/** Closes one toast, or every toast without an id. */
function dismiss(id?: string) {
    useToastStore.setState(({toasts}) => ({toasts: id === undefined ? [] : toasts.filter((shown) => shown.id !== id)}))
}

/** Back to no toasts and nothing announced; tests and stories call it before each case. */
export function resetToasts() {
    useToastStore.setState({toasts: [], replaced: null})
}

/**
 * Shows a toast and returns its id: `toast('Recording cancelled')`, or with a
 * tone, `toast.error('Download failed', {description: error.message})`. Pass
 * the id back to replace it, or to `toast.dismiss`.
 */
export const toast = Object.assign(
    (title: string, options?: ToastOptions) => show('message', title, options),
    {
        success: (title: string, options?: ToastOptions) => show('success', title, options),
        info: (title: string, options?: ToastOptions) => show('info', title, options),
        warning: (title: string, options?: ToastOptions) => show('warning', title, options),
        error: (title: string, options?: ToastOptions) => show('error', title, options),
        loading: (title: string, options?: ToastOptions) => show('loading', title, options),
        dismiss,
    },
)
