import {useMutation, useQuery} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {freeAllMemory, LOCAL_STACK_POLL_MS, localStackKeys, localStackQuery, unloadSpeechModels, whisperDevice} from '@/api/localStack'
import {Button} from '@/components/ui/Button'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {toast} from '@/components/ui/toastStore'
import {RowControls, RowValue} from '../styles'

const minutes = (seconds: number | undefined) => {
    if (!seconds) return 'a while'
    if (seconds < 60) return `${seconds} seconds`
    const count = Math.round(seconds / 60)
    return `${count} minute${count === 1 ? '' : 's'}`
}

/**
 * Settings › Advanced › Local AI, the speech half: which speech models are
 * loaded and on what, and the two ways to free memory. The status is read
 * every 5 s while it shows (native sends nothing when a model loads); both
 * unloads are refused during a recording. Disk is the AI half's row.
 */
export function LocalAiGroup() {
    const status = useQuery({...localStackQuery, refetchInterval: LOCAL_STACK_POLL_MS})
    const unload = useMutation({
        mutationFn: (all: boolean) => (all ? freeAllMemory() : unloadSpeechModels()),
        onSuccess: (_reply, all) => toast.success(all ? 'Speech and summary models unloaded' : 'Speech models unloaded'),
        onError: (error) => toast.error('Couldn’t unload the models', {description: errorMessage(error)}),
        onSettled: (_reply, _error, _all, _result, {client}) => client.invalidateQueries({queryKey: localStackKeys.status()}),
    })
    const data = status.data
    const parakeetOn = data?.parakeet.backend === 'DirectML' ? 'graphics card' : 'processor'
    const busy = unload.isPending || !data || data.recording

    return (
        <SettingsGroup title="Local AI">
            <SettingsRow
                label="Parakeet"
                control={<RowValue>{data ? (data.parakeet.loaded ? `Loaded · ${parakeetOn}` : 'Not loaded') : ''}</RowValue>}
            />
            <SettingsRow
                label="Whisper"
                control={<RowValue>{data ? (data.whisper.loaded ? `Loaded · ${whisperDevice(data)}` : 'Not loaded') : ''}</RowValue>}
            />
            <SettingsRow
                label="Memory"
                description={data?.recording
                    ? 'Nothing unloads during a recording'
                    : `Speech models unload after ${minutes(data?.sttIdleUnloadSecs)} without use, the summary model after ${minutes(data?.llmIdleUnloadSecs)}`}
            >
                <RowControls>
                    <Button size="sm" disabled={busy} pending={unload.isPending && unload.variables === false} onClick={() => unload.mutate(false)}>
                        Unload speech models
                    </Button>
                    <Button size="sm" disabled={busy} pending={unload.isPending && unload.variables === true} onClick={() => unload.mutate(true)}>
                        Free all memory
                    </Button>
                </RowControls>
            </SettingsRow>
        </SettingsGroup>
    )
}
