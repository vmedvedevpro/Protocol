import {useQuery} from '@tanstack/react-query'
import {useEffect} from 'react'
import {create} from 'zustand'
import {persist} from 'zustand/middleware'
import {errorMessage} from '@/api/core'
import {getKeepOnTopAvailable, setWindowAlwaysOnTop} from '@/api/window'
import {toast} from '@/components/ui/toastStore'

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
 * Whether the session lets the window stay on top (`getKeepOnTopAvailable`):
 * undefined until native code answers, so neither the pin nor the note that
 * it is unavailable shows before that.
 */
export function useKeepOnTopAvailable(): boolean | undefined {
    const {data} = useQuery({
        queryKey: ['window', 'keepOnTopAvailable'],
        queryFn: getKeepOnTopAvailable,
        // Fixed for the session.
        staleTime: Infinity,
    })
    return data
}

/**
 * Applies the pin to the native window, at startup too: the window opens
 * without it (tauri.conf.json) and takes it from the saved choice. Only where
 * the session allows it (`available`). A pin native code could not apply
 * (KWin's scripting off, a D-Bus error) goes back off and a toast says why.
 */
export function useKeepOnTopSync(available: boolean) {
    const onTop = useKeepOnTopStore((state) => state.onTop)
    const setOnTop = useKeepOnTopStore((state) => state.setOnTop)

    useEffect(() => {
        if (!available) return
        setWindowAlwaysOnTop(onTop).catch((error: unknown) => {
            console.warn('Failed to change keep on top:', error)
            if (onTop) {
                setOnTop(false)
                toast.error("Couldn't keep the window on top", {description: errorMessage(error)})
            } else {
                toast.error("Couldn't stop keeping the window on top", {description: errorMessage(error)})
            }
        })
    }, [available, onTop, setOnTop])
}
