import {useQueryClient} from '@tanstack/react-query'
import {useNativeEvent} from '@/api/events'
import {UPDATER_STATUS_EVENT, updaterStatusQuery} from '@/api/updater'

/**
 * Native code pushes the whole updater snapshot on every change, so it
 * replaces the cached one; no refetch. Mounted once, in App.
 */
export function useUpdaterStatusSync() {
    const queryClient = useQueryClient()

    useNativeEvent(UPDATER_STATUS_EVENT, (snapshot) => {
        queryClient.setQueryData(updaterStatusQuery.queryKey, snapshot)
    })
}
