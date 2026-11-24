import {useEffect, useEffectEvent} from 'react'
import {type DataTag, type QueryKey, useQueryClient} from '@tanstack/react-query'
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
    /**
     * Called once the listener is registered. Events sent before that went
     * nowhere, so this is the moment to read again what they would have changed.
     */
    onListening?: () => void
}

/**
 * Calls `handler` with each `event` payload while the component is mounted.
 * The handler always sees the latest props; the listener is registered once.
 */
export function useNativeEvent<T>(
    event: NativeEvent<T>,
    handler: (payload: T) => void,
    {target, onListening}: NativeEventOptions = {},
) {
    const onEvent = useEffectEvent(handler)
    const onRegistered = useEffectEvent(() => onListening?.())

    useEffect(() => {
        // listen() registers asynchronously: an unmount before it resolves
        // must still remove the listener once it exists.
        let disposed = false
        let unlisten: UnlistenFn | undefined
        listenNative(event, (payload: T) => onEvent(payload), {target}).then(
            (stop) => {
                if (disposed) {
                    stop()
                    return
                }
                unlisten = stop
                onRegistered()
            },
            (error: unknown) => console.error(`Failed to listen to ${event}:`, error),
        )
        return () => {
            disposed = true
            unlisten?.()
        }
    }, [event, target])
}

/**
 * Keeps a query current from an event that carries its whole value. The event
 * becomes the only writer of that query (docs/UI_ARCHITECTURE.md, Events):
 *
 * - A read still in flight when an event arrives is cancelled first. Replies
 *   and events reach the webview on separate channels in no fixed order, so
 *   the reply may hold an older value and would land over the event's.
 * - Once the listener is registered the query is read again, because events
 *   sent before that went nowhere.
 */
export function useEventQuerySync<T>(
    event: NativeEvent<T>,
    queryKey: DataTag<QueryKey, T, unknown>,
    {target}: Pick<NativeEventOptions, 'target'> = {},
) {
    const queryClient = useQueryClient()

    useNativeEvent(
        event,
        async (value) => {
            await queryClient.cancelQueries({queryKey})
            queryClient.setQueryData(queryKey, value)
        },
        {target, onListening: () => void queryClient.invalidateQueries({queryKey})},
    )
}
