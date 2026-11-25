/**
 * A finished summary can rename its meeting (#218): native gives a meeting
 * whose title is not the user's the title the summary wrote, then says the
 * run is done. Mounted once in the shell, so the list, a folder's latest
 * meeting, search and the open meeting show the new title whichever screen
 * is up when the run ends, the automatic summary after a recording included.
 */
import {useQueryClient} from '@tanstack/react-query'
import {searchKeys} from '@/features/search/api/search'
import {useNativeEvent} from '@/api/events'
import {folderKeys, meetingKeys, SUMMARY_PROGRESS_EVENT} from '@/api/meetings'

export function useSummaryTitleSync() {
    const client = useQueryClient()
    useNativeEvent(SUMMARY_PROGRESS_EVENT, ({meetingId, stage}) => {
        if (stage !== 'completed') return
        void Promise.all([
            client.invalidateQueries({queryKey: meetingKeys.lists()}),
            client.invalidateQueries({queryKey: meetingKeys.detail(meetingId)}),
            client.invalidateQueries({queryKey: folderKeys.all}),
            client.invalidateQueries({queryKey: searchKeys.all}),
        ])
    })
}
