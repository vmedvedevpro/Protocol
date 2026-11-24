import {useEffect, useEffectEvent} from 'react'
import {listen, type UnlistenFn} from '@tauri-apps/api/event'
import {UPDATER_STATUS_EVENT, type UpdaterSnapshot} from './updater'

/**
 * Every native event the UI listens to, by name, with its payload. Add an
 * entry next to the domain wrapper that owns the event.
 */
export interface NativeEvents {
    [UPDATER_STATUS_EVENT]: UpdaterSnapshot
}

export type NativeEventName = keyof NativeEvents

export function listenNative<E extends NativeEventName>(
    event: E,
    handler: (payload: NativeEvents[E]) => void,
): Promise<UnlistenFn> {
    return listen<NativeEvents[E]>(event, (message) => handler(message.payload))
}

/**
 * Calls `handler` with each `event` payload while the component is mounted.
 * The handler always sees the latest props; the listener is registered once.
 */
export function useNativeEvent<E extends NativeEventName>(
    event: E,
    handler: (payload: NativeEvents[E]) => void,
) {
    const onEvent = useEffectEvent(handler)

    useEffect(() => {
        // listen() registers asynchronously: an unmount before it resolves
        // must still remove the listener once it exists.
        let disposed = false
        let unlisten: UnlistenFn | undefined
        listenNative(event, (payload) => onEvent(payload)).then(
            (stop) => {
                if (disposed) stop()
                else unlisten = stop
            },
            (error: unknown) => console.error(`Failed to listen to ${event}:`, error),
        )
        return () => {
            disposed = true
            unlisten?.()
        }
    }, [event])
}
