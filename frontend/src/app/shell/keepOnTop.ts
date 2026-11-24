import {useEffect} from 'react'
import {create} from 'zustand'
import {persist} from 'zustand/middleware'
import {setWindowAlwaysOnTop} from '@/api/window'

/**
 * New in Frontend 2.0 (the old app had no such toggle), so Zustand's own
 * format under a new key. Only the main window reads it; the minibar is
 * always on top anyway (minibar.rs).
 */
export const KEEP_ON_TOP_STORAGE_KEY = 'protocol-keep-on-top'

interface KeepOnTopState {
    onTop: boolean
    setOnTop: (onTop: boolean) => void
}

/** The title bar's pin: keeps the main window above the call it sits next to. */
export const useKeepOnTopStore = create<KeepOnTopState>()(
    persist(
        (set) => ({
            onTop: false,
            setOnTop: (onTop) => set({onTop}),
        }),
        {
            name: KEEP_ON_TOP_STORAGE_KEY,
            partialize: ({onTop}) => ({onTop}),
        },
    ),
)

/**
 * Applies the pin to the native window, at startup too: the window opens
 * without it (tauri.conf.json) and takes it from the saved choice.
 */
export function useKeepOnTopSync() {
    const onTop = useKeepOnTopStore((state) => state.onTop)

    useEffect(() => {
        setWindowAlwaysOnTop(onTop).catch((error: unknown) => console.warn('Failed to keep the window on top:', error))
    }, [onTop])
}
