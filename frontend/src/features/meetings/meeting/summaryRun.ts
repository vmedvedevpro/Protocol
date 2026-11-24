import {useState} from 'react'
import {useQueryClient} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import {useNativeEvent} from '@/api/events'
import {meetingKeys, startSummary, SUMMARY_PROGRESS_EVENT} from '@/api/meetings'
import {type BuiltInModelStatus, isBuiltInModelReady, listBuiltInModels} from '@/api/models'
import {summaryModelQuery} from '@/api/preferences'
import {toast} from '@/components/ui/toastStore'
import {paths} from '@/lib/paths'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Why a built-in model cannot write now, for a toast; null when the status allows it. */
function builtInProblem(model: string, status: BuiltInModelStatus | undefined): { title: string, description: string } | null {
    switch (status?.type) {
        case 'downloading':
            return {title: 'The summary model is still downloading', description: `${model} is at ${status.progress}%. Try again when it finishes.`}
        case 'not_downloaded':
            return {title: 'The summary model isn’t downloaded', description: `Download ${model} in Settings.`}
        case 'incomplete':
            return {title: 'The summary model’s download is incomplete', description: `Resume ${model} in Settings.`}
        case 'corrupted':
            return {title: 'The summary model is damaged', description: `Download ${model} again in Settings.`}
        case 'error':
            return {title: 'The summary model can’t be used', description: status.message}
        default:
            return null
    }
}

/**
 * Writes the meeting's summary, or writes it again: checks the summary
 * model first (a provider chosen; a built-in model downloaded and whole),
 * then starts the run (`startSummary`) and reads the summary again, which
 * now reports the run. Problems become toasts that lead to Settings. The
 * run itself goes on natively; each `summary-progress` of this meeting
 * reads the summary again, and the summary's poll catches a run that ends
 * without one. A bilingual transcript gets a note on the language Auto
 * picked.
 */
export function useWriteSummary(meetingId: string) {
    const client = useQueryClient()
    const navigate = useNavigate()
    const [starting, setStarting] = useState(false)
    const toSettings = {label: 'Open Settings', onClick: () => void navigate(paths.settingsPage('summary-model'))}

    useNativeEvent(SUMMARY_PROGRESS_EVENT, (progress) => {
        if (progress.meetingId === meetingId) void client.invalidateQueries({queryKey: meetingKeys.summary(meetingId)})
    })

    const write = async ({again = false} = {}) => {
        if (starting) return
        setStarting(true)
        try {
            const config = await client.fetchQuery(summaryModelQuery).catch(() => null)
            if (!config?.provider || !config.model) {
                toast.error('Choose a summary model', {
                    id: 'choose-summary-model',
                    description: config?.provider === ''
                        ? 'The provider chosen before is no longer available. Pick another one in Settings.'
                        : 'Pick one in Settings.',
                    action: toSettings,
                })
                return
            }
            if (config.provider === 'builtin-ai' && !(await isBuiltInModelReady(config.model, {refresh: true}).catch(() => false))) {
                const info = (await listBuiltInModels().catch(() => [])).find((model) => model.name === config.model)
                const problem = builtInProblem(info?.display_name ?? config.model, info?.status)
                    ?? {title: 'The summary model isn’t ready', description: 'Check it in Settings.'}
                toast.error(problem.title, {description: problem.description, action: toSettings})
                return
            }
            const start = await startSummary({meetingId, provider: config.provider, model: config.model})
            if (start.languageTie) {
                toast.warning('Bilingual transcript detected', {
                    description: 'Two languages were spoken about equally; the summary uses one of them.',
                })
            }
        } catch (error) {
            toast.error(again ? 'Couldn’t write the summary again' : 'Couldn’t write the summary', {description: message(error)})
        } finally {
            setStarting(false)
            await client.invalidateQueries({queryKey: meetingKeys.summary(meetingId)})
        }
    }

    return {write, starting}
}
