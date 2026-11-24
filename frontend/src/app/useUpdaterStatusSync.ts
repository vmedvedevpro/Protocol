import {useEventQuerySync} from '@/api/events'
import {UPDATER_STATUS_EVENT, updaterStatusQuery} from '@/api/updater'

/**
 * Native code pushes the whole updater snapshot to every window on each
 * change; the event keeps the cached one current. Mounted once, in App.
 */
export function useUpdaterStatusSync() {
    useEventQuerySync(UPDATER_STATUS_EVENT, updaterStatusQuery.queryKey)
}
