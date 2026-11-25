import {useState} from 'react'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {useNativeEvent} from '@/api/events'
import {openLink} from '@/api/links'
import {Button} from '@/components/ui/Button'
import {ProgressBar} from '@/components/ui/ProgressBar'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {Spinner} from '@/components/ui/Spinner'
import {TextField} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'
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
} from '../../api/summaryProviders'
import {Actions, InUse} from './styles'

interface OllamaGroupProps {
    endpoint: string
    onEndpoint: (endpoint: string) => void
    /** The endpoint whose models are listed. */
    fetched: string
    onFetch: () => void
    model: string | undefined
    onModel: (model: string) => void
}

/**
 * An Ollama server: its endpoint, the models on it to choose or remove, and
 * the small starter model to get. Its models are listed for the endpoint
 * last fetched; Save waits until that is the one typed.
 */
export function OllamaGroup({endpoint, onEndpoint, fetched, onFetch, model, onModel}: OllamaGroupProps) {
    const client = useQueryClient()
    const server = fetched.trim() || null
    const models = useQuery(ollamaModelsQuery(server))
    const refresh = () => client.invalidateQueries({queryKey: summaryProviderKeys.ollama(server)})

    // Native sends a pull's percent; the pull's own call ends it.
    const [pulled, setPulled] = useState<number | null>(null)
    useNativeEvent(OLLAMA_PULL_PROGRESS_EVENT, ({modelName, progress}) => {
        if (modelName === OLLAMA_STARTER_MODEL.name) setPulled(progress)
    })
    const pull = useMutation({
        mutationFn: () => pullOllamaModel(OLLAMA_STARTER_MODEL.name, server),
        onMutate: () => setPulled(0),
        onSuccess: () => onModel(OLLAMA_STARTER_MODEL.name),
        onError: (error) => toast.error(`Couldn’t get ${OLLAMA_STARTER_MODEL.name}`, {description: errorMessage(error)}),
        onSettled: () => {
            setPulled(null)
            return refresh()
        },
    })
    const remove = useMutation({
        mutationFn: (name: string) => deleteOllamaModel(name, server),
        onError: (error, name) => toast.error(`Couldn’t remove ${name}`, {description: errorMessage(error)}),
        onSettled: refresh,
    })

    const unreachable = models.isError && isOllamaUnreachable(models.error)
    const hasStarter = models.data?.some(({name}) => name === OLLAMA_STARTER_MODEL.name)
    const changed = endpoint.trim() !== fetched.trim()

    return (
        <SettingsGroup title="Ollama">
            <SettingsRow label="Endpoint" description={changed ? 'Fetch the models of this server before saving' : 'Optional'}>
                <Actions>
                    <TextField
                        placeholder={OLLAMA_DEFAULT_ENDPOINT}
                        spellCheck={false}
                        value={endpoint}
                        onChange={(event) => onEndpoint(event.target.value)}
                    />
                    <Button size="sm" pending={models.isFetching} onClick={() => (changed ? onFetch() : void refresh())}>Fetch models</Button>
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
                <SettingsRow
                    key={name}
                    label={name}
                    description={size}
                    control={name === model ? <InUse>In use</InUse> : (
                        <Actions>
                            <Button size="sm" aria-label={`Use ${name}`} onClick={() => onModel(name)}>Use</Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Remove ${name}`}
                                pending={remove.isPending && remove.variables === name}
                                onClick={() => remove.mutate(name)}
                            >
                                Remove
                            </Button>
                        </Actions>
                    )}
                />
            ))}
            {models.isSuccess && !hasStarter && (
                <SettingsRow
                    label="Get a model"
                    description={pulled === null
                        ? `${OLLAMA_STARTER_MODEL.name}, ${OLLAMA_STARTER_MODEL.size}`
                        : `Downloading ${OLLAMA_STARTER_MODEL.name} · ${pulled}%`}
                    control={(
                        <Button size="sm" aria-label={`Download ${OLLAMA_STARTER_MODEL.name}`} pending={pull.isPending} onClick={() => pull.mutate()}>
                            Download
                        </Button>
                    )}
                >
                    {pulled !== null && <ProgressBar label={`Downloading ${OLLAMA_STARTER_MODEL.name}`} value={pulled}/>}
                </SettingsRow>
            )}
        </SettingsGroup>
    )
}
