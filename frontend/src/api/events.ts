import {useEffect, useEffectEvent} from 'react'
import {listen, type Options, type UnlistenFn} from '@tauri-apps/api/event'

declare const payloadType: unique symbol

/**
 * A native event's name, carrying its payload type. The domain file that owns
 * the event declares it next to its wrappers:
 * `export const UPDATER_STATUS_EVENT = 'updater-status' as NativeEvent<UpdaterSnapshot>`.
 */
export type NativeEvent<T> = string & { readonly [payloadType]: T }

/**
 * Without `options.target`, a listener hears every event of that name,
 * including those native code sent to another window with `emit_to`; a
 * window or webview label as `target` limits it to that one and to events
 * sent to all.
 */
export function listenNative<T>(
    event: NativeEvent<T>,
    handler: (payload: T) => void,
    options?: Options,
): Promise<UnlistenFn> {
    return listen<T>(event, (message) => handler(message.payload), options)
}

export interface NativeEventOptions {
    /** A window or webview label; see listenNative. */
    target?: string
}

/**
 * Calls `handler` with each `event` payload while the component is mounted.
 * The handler always sees the latest props; the listener is registered once.
 */
export function useNativeEvent<T>(
    event: NativeEvent<T>,
    handler: (payload: T) => void,
    {target}: NativeEventOptions = {},
) {
    const onEvent = useEffectEvent(handler)

    useEffect(() => {
        // listen() registers asynchronously: an unmount before it resolves
        // must still remove the listener once it exists.
        let disposed = false
        let unlisten: UnlistenFn | undefined
        listenNative(event, (payload: T) => onEvent(payload), {target}).then(
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
    }, [event, target])
}
