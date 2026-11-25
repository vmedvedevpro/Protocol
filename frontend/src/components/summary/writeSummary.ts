import {useState} from 'react'
import {useQueryClient} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import {errorMessage} from '@/api/core'
import {useNativeEvent} from '@/api/events'
import {summaryCleaner} from '@/api/labs'
import {meetingKeys, startSummary, SUMMARY_PROGRESS_EVENT} from '@/api/meetings'
import {type BuiltInModelStatus, isBuiltInModelReady, listBuiltInModels} from '@/api/models'
import {summaryModelQuery} from '@/api/preferences'
import {toast} from '@/components/ui/toastStore'
import {paths} from '@/lib/paths'

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

export interface WriteOptions {
    /** Writing over a summary there is; only the error toast differs. */
    again?: boolean
    /** Summary options (#119): a template for this run; left out, the stored default. */
    templateId?: string
    /** Summary options' "Write it again": what to focus on, for this run only. */
    customPrompt?: string
}

/**
 * Writes the meeting's summary, or writes it again: checks the summary
 * model first (a provider chosen; a built-in model downloaded and whole),
 * then starts the run (`startSummary`) and reads the summary again, which
 * now reports the run. Problems become toasts that lead to Settings. The
 * run itself goes on natively; each `summary-progress` of this meeting
 * reads the summary again, and the summary's poll catches a run that ends
 * without one. A bilingual transcript gets a note on the language Auto
 * picked. `write` answers whether the run started.
 *
 * The meeting screen writes with it, and Summary options (features/dialogs)
 * writes again with a template and instructions.
 */
export function useWriteSummary(meetingId: string) {
    const client = useQueryClient()
    const navigate = useNavigate()
    const [starting, setStarting] = useState(false)
    const toSettings = {label: 'Open Settings', onClick: () => void navigate(paths.settingsPage('summary-model'))}

    useNativeEvent(SUMMARY_PROGRESS_EVENT, (progress) => {
        if (progress.meetingId === meetingId) void client.invalidateQueries({queryKey: meetingKeys.summary(meetingId)})
    })

    const write = async ({again = false, templateId, customPrompt}: WriteOptions = {}): Promise<boolean> => {
        if (starting) return false
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
                return false
            }
            if (config.provider === 'builtin-ai' && !(await isBuiltInModelReady(config.model, {refresh: true}).catch(() => false))) {
                const info = (await listBuiltInModels().catch(() => [])).find((model) => model.name === config.model)
                const problem = builtInProblem(info?.display_name ?? config.model, info?.status)
                    ?? {title: 'The summary model isn’t ready', description: 'Check it in Settings.'}
                toast.error(problem.title, {description: problem.description, action: toSettings})
                return false
            }
            const start = await startSummary({meetingId, provider: config.provider, model: config.model, templateId, customPrompt, clean: summaryCleaner()})
            if (start.languageTie) {
                toast.warning('Bilingual transcript detected', {
                    description: 'Two languages were spoken about equally; the summary uses one of them.',
                })
            }
            return true
        } catch (error) {
            toast.error(again ? 'Couldn’t write the summary again' : 'Couldn’t write the summary', {description: errorMessage(error)})
            return false
        } finally {
            // Starting ends once the summary read again shows the run:
            // cleared first, the panel would show no summary for a moment.
            await client.invalidateQueries({queryKey: meetingKeys.summary(meetingId)})
            setStarting(false)
        }
    }

    return {write, starting}
}
