import {useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import type {SummaryChoice} from '@/api/onboarding'
import {apiKeyQuery, type CustomServerConfig, type SummaryModelChoice, summaryModelQuery} from '@/api/preferences'
import {type CloudProvider, isCloudProvider} from '@/api/summaryProviders'
import {choiceOf, initialDraft, type SummaryModelDraft, WHISPER_MODEL_DEFAULT} from '@/components/summaryModel/draft'
import {type DownloadRow, useSummaryDownload} from './useFirstLaunchDownloads'

/** How summaries get written: the built-in model, a provider with the user's key, or not yet. */
export type SummaryWay = 'builtIn' | 'provider' | 'later'

/**
 * The built-in model counts as chosen once its download runs: Install was
 * pressed and not cancelled. Unlike Settings' Save, which waits for the
 * download, first launch selects it then; the post-call pass uses it only
 * once it is downloaded (`usableSummaryModel`), and Home's missing-model
 * banner offers the download again when it was cut short.
 */
const installing = (row: DownloadRow | null) =>
    row !== null && (row.state.kind === 'downloading' || row.state.kind === 'activating' || row.state.kind === 'ready')

/** What Done does for summaries: the provider's choice to save first, and what `complete_onboarding` records. */
export interface SummaryFinish {
    save?: {choice: SummaryModelChoice, customServer?: CustomServerConfig}
    summary: SummaryChoice
}

export interface SummaryChoiceState {
    way: SummaryWay
    setWay: (way: SummaryWay) => void
    /** The recommended built-in model's row; null until it is known. */
    builtIn: DownloadRow | null
    draft: SummaryModelDraft
    change: (patch: Partial<SummaryModelDraft>) => void
    /** The chosen cloud provider, once its saved key has been read. */
    cloud: CloudProvider | undefined
    /** The key the field shows: typed, else the one saved for the provider. */
    apiKey: string
    /** What Done saves and records, or null while the chosen way is incomplete. */
    finish: SummaryFinish | null
}

/**
 * First launch's summary choice until Done. Nothing is stored before it:
 * the key stays in the draft, and Done saves the provider's choice with the
 * same checks and command as Settings › Summary model (`choiceOf`,
 * `saveSummaryModelMutation`), which keep the key in native storage. The
 * built-in model is chosen by installing it; Later records nothing, so
 * summaries stay off until a model is set.
 */
export function useSummaryChoice(): SummaryChoiceState {
    const [way, setWay] = useState<SummaryWay>('later')
    const [draft, setDraft] = useState(() => initialDraft(null, null, {}))
    const change = (patch: Partial<SummaryModelDraft>) => setDraft((current) => ({...current, ...patch}))
    const builtIn = useSummaryDownload()

    const provider = isCloudProvider(draft.provider) ? draft.provider : undefined
    // A reinstall keeps the database, and with it a key saved before.
    const savedKey = useQuery({...apiKeyQuery(provider ?? 'claude'), enabled: way === 'provider' && provider !== undefined})
    const saved = useQuery({...summaryModelQuery, enabled: way === 'provider'})
    const cloud = provider && savedKey.isSuccess ? provider : undefined
    const apiKey = cloud ? draft.apiKeys[cloud] ?? savedKey.data ?? '' : ''

    let finish: SummaryFinish | null = null
    if (way === 'later') finish = {summary: {provider: null, model: null, ready: false}}
    if (way === 'builtIn' && builtIn && installing(builtIn)) {
        finish = {summary: {provider: 'builtin-ai', model: builtIn.download.model, ready: builtIn.state.kind === 'ready'}}
    }
    if (way === 'provider' && cloud) {
        const save = choiceOf(draft, {apiKey, builtInReady: false, whisperModel: saved.data?.whisperModel || WHISPER_MODEL_DEFAULT})
        if (save) finish = {save, summary: {provider: cloud, model: save.choice.model, ready: true}}
    }

    return {way, setWay, builtIn, draft, change, cloud, apiKey, finish}
}
