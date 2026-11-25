import {useState} from 'react'
import {useMutation, useQuery} from '@tanstack/react-query'
import {
    type BuiltInModelInfo,
    builtInModelsQuery,
    cancelBuiltInDownload,
    deleteBuiltInModelMutation,
    downloadBuiltInModel,
    downloadKey,
    downloadsQuery,
    modelState,
    recommendedSummaryModelQuery,
} from '@/api/models'
import {errorMessage} from '@/api/core'
import {Button} from '@/components/ui/Button'
import {ProgressBar} from '@/components/ui/ProgressBar'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {toast} from '@/components/ui/toastStore'
import {shortModelName} from '../summaryModel'
import {Actions, InUse} from './styles'

const gigabytes = (bytes: number | null | undefined) => (bytes ? `${(bytes / 1e9).toFixed(1)} GB` : undefined)

interface ModelRowProps {
    model: BuiltInModelInfo
    recommended: boolean
    chosen: boolean
    onChoose: () => void
}

/**
 * One built-in model: Download, its progress with Cancel, Use and Delete
 * once it is here, "In use" for the chosen one. A download outlives this
 * page: its progress comes back through `downloadsQuery`.
 */
function ModelRow({model, recommended, chosen, onChoose}: ModelRowProps) {
    const [starting, setStarting] = useState(false)
    const downloads = useQuery(downloadsQuery)
    const key = downloadKey('builtIn', model.name)
    const state = modelState(model.status, downloads.data?.[key])
    const remove = useMutation({
        ...deleteBuiltInModelMutation,
        onError: (error) => toast.error(`Couldn’t delete ${shortModelName(model.display_name)}`, {description: errorMessage(error)}),
    })
    const name = shortModelName(model.display_name)

    // The button waits until native's first progress event replaces it; the
    // sync records a failure from its event, and a cancel is no failure.
    const download = () => {
        setStarting(true)
        downloadBuiltInModel(model.name).catch(() => undefined).finally(() => setStarting(false))
    }

    const facts = [recommended ? 'Recommended for this computer' : undefined, gigabytes(model.size_bytes)].filter(Boolean).join(' · ')
    let description = facts
    let control
    if (state.kind === 'downloading') {
        description = `Downloading · ${Math.round(state.progress)}%`
        control = (
            <Button size="sm" variant="ghost" aria-label={`Cancel downloading ${name}`} onClick={() => void cancelBuiltInDownload(model.name).catch(() => undefined)}>
                Cancel
            </Button>
        )
    } else if (state.kind === 'ready') {
        control = chosen ? <InUse>In use</InUse> : (
            <Actions>
                <Button size="sm" aria-label={`Use ${name}`} onClick={onChoose}>Use</Button>
                <Button size="sm" variant="ghost" aria-label={`Delete ${name}`} pending={remove.isPending} onClick={() => remove.mutate(model.name)}>
                    Delete
                </Button>
            </Actions>
        )
    } else if (state.kind === 'failed') {
        description = state.error
        control = <Button size="sm" aria-label={`Download ${name} again`} pending={starting} onClick={download}>Try again</Button>
    } else {
        control = <Button size="sm" aria-label={`Download ${name}`} pending={starting} onClick={download}>Download</Button>
    }

    return (
        <SettingsRow label={name} description={description} control={control}>
            {state.kind === 'downloading' && <ProgressBar label={`Downloading ${name}`} value={state.progress}/>}
        </SettingsRow>
    )
}

interface BuiltInModelsGroupProps {
    model: string | undefined
    onChoose: (model: string) => void
}

/** The models the app runs itself; the recommendation comes from this computer's memory. */
export function BuiltInModelsGroup({model, onChoose}: BuiltInModelsGroupProps) {
    const models = useQuery(builtInModelsQuery)
    const recommended = useQuery(recommendedSummaryModelQuery)
    return (
        <SettingsGroup title="Built-in models" note="The recommendation depends on how much memory this computer has.">
            {models.isError && <SettingsRow label="Couldn’t list the models" description={errorMessage(models.error)}/>}
            {models.data?.map((entry) => (
                <ModelRow
                    key={entry.name}
                    model={entry}
                    recommended={entry.name === recommended.data}
                    chosen={entry.name === model}
                    onChoose={() => onChoose(entry.name)}
                />
            ))}
        </SettingsGroup>
    )
}
