import {useState} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {chooseLogsDestination, logKeys, logStatusQuery, saveLogsZip, showSavedLogs} from '@/api/logs'
import {Button} from '@/components/ui/Button'
import {Collapse} from '@/components/ui/Collapse'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {toast} from '@/components/ui/toastStore'
import {Warning} from './styles'

/** The file's own name, for "Saved as …"; native returns the whole path. */
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path

/**
 * Settings › Advanced › Bug reports: Save logs puts Protocol's log, the
 * updater's journal and a pending crash report into one ZIP for a bug
 * report (src-tauri/src/app_log/bundle.rs). When the log cannot be written,
 * the row says why instead of its description.
 */
export function LogsGroup() {
    const queryClient = useQueryClient()
    const status = useQuery(logStatusQuery)
    // The last ZIP saved on this visit; kept while its row closes.
    const [saved, setSaved] = useState<string | null>(null)
    const save = useMutation({
        mutationFn: async () => {
            const destination = await chooseLogsDestination()
            return destination ? saveLogsZip(destination) : null
        },
        onSuccess: (path) => {
            if (path) setSaved(path)
        },
        onError: (error) => toast.error('Couldn’t save the logs', {description: errorMessage(error)}),
        // A write that failed meanwhile shows on the row.
        onSettled: () => queryClient.invalidateQueries({queryKey: logKeys.status()}),
    })
    const show = useMutation({
        mutationFn: showSavedLogs,
        onError: (error) => toast.error('Couldn’t show the file', {description: errorMessage(error)}),
    })
    const problem = status.isError ? errorMessage(status.error) : status.data?.problem

    return (
        <SettingsGroup title="Bug reports">
            <SettingsRow
                label="Logs"
                description={problem
                    ? <Warning as="span">{problem}</Warning>
                    : 'One ZIP to attach to a bug report. Recordings, transcripts and keys stay out of it.'}
                control={<Button size="sm" pending={save.isPending} onClick={() => save.mutate()}>Save logs</Button>}
            />
            <Collapse open={saved !== null && !save.isPending}>
                {saved !== null && (
                    <SettingsRow
                        label={`Saved as ${fileName(saved)}`}
                        control={(
                            <Button size="sm" pending={show.isPending} onClick={() => show.mutate(saved)}>
                                Show in folder
                            </Button>
                        )}
                    />
                )}
            </Collapse>
        </SettingsGroup>
    )
}
