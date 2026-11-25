import {useQuery} from '@tanstack/react-query'
import {type BuiltInModelInfo, builtInModelsQuery, downloadKey, downloadsQuery, modelState} from '@/api/models'
import {summaryModelQuery} from '@/api/preferences'

/**
 * The built-in summary model in use when it is not on this computer and no
 * download of it runs: first launch's download was cut by a quit (#121), it
 * failed, or the file went away. Null otherwise, and for any other provider.
 */
export function useMissingSummaryModel(): BuiltInModelInfo | null {
    const config = useQuery(summaryModelQuery).data
    const builtIn = config?.provider === 'builtin-ai'
    const models = useQuery({...builtInModelsQuery, enabled: builtIn}).data
    const downloads = useQuery(downloadsQuery).data ?? {}
    if (!builtIn) return null
    const model = models?.find(({name}) => name === config.model)
    if (!model) return null
    const state = modelState(model.status, downloads[downloadKey('builtIn', model.name)])
    return state.kind === 'missing' || state.kind === 'failed' ? model : null
}
