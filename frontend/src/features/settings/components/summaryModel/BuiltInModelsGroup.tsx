import {useMutation, useQuery} from '@tanstack/react-query'
import {
    builtInModelsQuery,
    cancelBuiltInDownload,
    deleteBuiltInModelMutation,
    downloadBuiltInModel,
    downloadsQuery,
    recommendedSummaryModelQuery,
} from '@/api/models'
import {errorMessage} from '@/api/core'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {ModelRow} from '../ModelRow'
import {shortModelName} from '../summaryModel'

interface BuiltInModelsGroupProps {
    model: string | undefined
    onChoose: (model: string) => void
}

/**
 * The models the app runs itself; the recommendation comes from this
 * computer's memory. A download outlives this page: its progress comes back
 * through `downloadsQuery`, and the sync records a failure from its event
 * (the download's own call rejects too, which says nothing new; a cancel
 * is no failure).
 */
export function BuiltInModelsGroup({model, onChoose}: BuiltInModelsGroupProps) {
    const models = useQuery(builtInModelsQuery)
    const recommended = useQuery(recommendedSummaryModelQuery)
    const downloads = useQuery(downloadsQuery).data ?? {}
    const remove = useMutation(deleteBuiltInModelMutation)
    return (
        <SettingsGroup title="Built-in models" note="The recommendation depends on how much memory this computer has.">
            {models.isError && <SettingsRow label="Couldn’t list the models" description={errorMessage(models.error)}/>}
            {models.data?.map((entry) => (
                <ModelRow
                    key={entry.name}
                    name={shortModelName(entry.display_name)}
                    engine="builtIn"
                    model={entry}
                    downloads={downloads}
                    use={entry.name === model ? 'Writes your summaries' : null}
                    description={entry.name === recommended.data ? 'Recommended for this computer' : ''}
                    onDownload={() => void downloadBuiltInModel(entry.name).catch(() => undefined)}
                    onCancel={() => void cancelBuiltInDownload(entry.name).catch(() => undefined)}
                    onUse={() => onChoose(entry.name)}
                    // The model in use stays: removing it would leave summaries without one.
                    onRemove={entry.name === model ? undefined : () => remove.mutateAsync(entry.name)}
                />
            ))}
        </SettingsGroup>
    )
}
