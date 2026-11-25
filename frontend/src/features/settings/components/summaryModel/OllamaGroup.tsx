import {useState} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {useNativeEvent} from '@/api/events'
import {openLink} from '@/api/links'
import {Button} from '@/components/ui/Button'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {Spinner} from '@/components/ui/Spinner'
import {TextField} from '@/components/ui/TextField'
import {
    deleteOllamaModel,
    isOllamaUnreachable,
    OLLAMA_DEFAULT_ENDPOINT,
    OLLAMA_DOWNLOAD_URL,
    OLLAMA_PULL_PROGRESS_EVENT,
    OLLAMA_STARTER_MODEL,
    ollamaModelsQuery,
    pullOllamaModel,
    summaryProviderKeys,
} from '@/api/summaryProviders'
import {useDebouncedSave} from '@/lib/useDebouncedSave'
import {ModelRow} from '../ModelRow'
import {TYPING_SETTLE_MS} from '@/components/summaryModel/draft'
import {Actions} from './styles'

interface OllamaGroupProps {
    endpoint: string
    onEndpoint: (endpoint: string) => void
    model: string | undefined
    onModel: (model: string) => void
}

/**
 * An Ollama server: its endpoint, the models on it to choose or remove, and
 * the small starter model to get. Its models are listed for the endpoint
 * once typing it has rested (a server that is not there takes 5 s to say
 * so); Fetch models asks again at once.
 */
export function OllamaGroup({endpoint, onEndpoint, model, onModel}: OllamaGroupProps) {
    const client = useQueryClient()
    const [settled, setSettled] = useState(endpoint.trim())
    const typing = useDebouncedSave(setSettled, TYPING_SETTLE_MS)
    const server = settled || null
    const models = useQuery(ollamaModelsQuery(server))
    const refresh = () => client.invalidateQueries({queryKey: summaryProviderKeys.ollama(server)})
    const fetchNow = () => (endpoint.trim() === settled ? void models.refetch() : setSettled(endpoint.trim()))

    // Native sends a pull's percent; the pull's own call ends it. There is no cancel.
    const [pulled, setPulled] = useState<number | null>(null)
    useNativeEvent(OLLAMA_PULL_PROGRESS_EVENT, ({modelName, progress}) => {
        if (modelName === OLLAMA_STARTER_MODEL.name) setPulled(progress)
    })
    const pull = useMutation({
        mutationFn: () => pullOllamaModel(OLLAMA_STARTER_MODEL.name, server),
        onMutate: () => setPulled(0),
        onSuccess: () => onModel(OLLAMA_STARTER_MODEL.name),
        onSettled: () => {
            setPulled(null)
            return refresh()
        },
    })
    const remove = (name: string) => deleteOllamaModel(name, server).finally(refresh)

    const unreachable = models.isError && isOllamaUnreachable(models.error)
    const hasStarter = models.data?.some(({name}) => name === OLLAMA_STARTER_MODEL.name)
    const starterState = pulled !== null
        ? {kind: 'downloading' as const, progress: Math.min(pulled, 99)}
        : pull.isError ? {kind: 'failed' as const, error: errorMessage(pull.error)} : {kind: 'missing' as const}

    return (
        <SettingsGroup title="Ollama">
            <SettingsRow label="Endpoint" description="Optional">
                <Actions>
                    <TextField
                        placeholder={OLLAMA_DEFAULT_ENDPOINT}
                        spellCheck={false}
                        value={endpoint}
                        onChange={(event) => {
                            onEndpoint(event.target.value)
                            typing.change(event.target.value.trim())
                        }}
                    />
                    <Button size="sm" pending={models.isFetching || typing.draft !== null} onClick={fetchNow}>Fetch models</Button>
                </Actions>
            </SettingsRow>
            {models.isPending && <SettingsRow label="Models" description="Looking for models…" control={<Spinner/>}/>}
            {unreachable && (
                <SettingsRow
                    label="Ollama isn’t running here"
                    description="Install Ollama or start it, then fetch the models again"
                    control={<Button size="sm" onClick={() => openLink(OLLAMA_DOWNLOAD_URL)}>Download Ollama</Button>}
                />
            )}
            {models.isError && !unreachable && <SettingsRow label="Couldn’t list the models" description={errorMessage(models.error)}/>}
            {models.data?.length === 0 && <SettingsRow label="Models" description="None found on this server yet"/>}
            {models.data?.map(({name, size}) => (
                <ModelRow
                    key={name}
                    name={name}
                    model={{name}}
                    state={{kind: 'ready'}}
                    use={name === model ? 'Writes your summaries' : null}
                    description={size}
                    onUse={() => onModel(name)}
                    onRemove={name === model ? undefined : () => remove(name)}
                />
            ))}
            {models.isSuccess && !hasStarter && (
                <ModelRow
                    name={OLLAMA_STARTER_MODEL.name}
                    model={{name: OLLAMA_STARTER_MODEL.name, size_bytes: OLLAMA_STARTER_MODEL.bytes}}
                    state={starterState}
                    description={OLLAMA_STARTER_MODEL.description}
                    onDownload={() => pull.mutate()}
                />
            )}
        </SettingsGroup>
    )
}
