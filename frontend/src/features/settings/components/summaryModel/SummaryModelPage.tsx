import {useState} from 'react'
import {useMutation, useQuery} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {builtInModelsQuery, modelState, recommendedSummaryModelQuery} from '@/api/models'
import {
    apiKeyQuery,
    customServerQuery,
    saveSummaryModelMutation,
    type CustomServerConfig,
    type SummaryModelConfig,
    type SummaryProvider,
    summaryModelQuery,
} from '@/api/preferences'
import {Button} from '@/components/ui/Button'
import {SettingsRadioGroup, SettingsRadioRow} from '@/components/ui/SettingsRow'
import {Spinner} from '@/components/ui/Spinner'
import {toast} from '@/components/ui/toastStore'
import {isCloudProvider, useProviderModelMapStore} from '../../api/summaryProviders'
import {SubpageFooter, type SubpageProps, SubpageGroups, SubpageScroll} from '../subpage'
import {Warning} from '../styles'
import {SUMMARY_PROVIDERS} from '../summaryModel'
import {BuiltInModelsGroup} from './BuiltInModelsGroup'
import {CloudGroup} from './CloudGroup'
import {CustomServerGroup} from './CustomServerGroup'
import {choiceOf, initialDraft, type SummaryModelDraft} from './draft'
import {OllamaGroup} from './OllamaGroup'

/** What the old settings stored beside the summary model when nothing was saved yet. */
const WHISPER_MODEL_DEFAULT = 'large-v3'

const PROVIDER_ORDER = Object.keys(SUMMARY_PROVIDERS) as SummaryProvider[]

interface FormProps extends SubpageProps {
    config: SummaryModelConfig | null
    customServer: CustomServerConfig | null
}

function SummaryModelForm({config, customServer, back}: FormProps) {
    const modelMap = useProviderModelMapStore((state) => state.value)
    const setModelMap = useProviderModelMapStore((state) => state.set)
    const [draft, setDraft] = useState(() => initialDraft(config, customServer, modelMap))
    const change = (patch: Partial<SummaryModelDraft>) => setDraft((current) => ({...current, ...patch}))
    const {provider} = draft

    const cloud = isCloudProvider(provider) ? provider : undefined
    const savedKey = useQuery({...apiKeyQuery(cloud ?? 'claude'), enabled: cloud !== undefined})
    const apiKey = cloud ? draft.apiKeys[cloud] ?? savedKey.data ?? '' : ''

    // Built-in AI without a model of its own takes this computer's recommendation.
    const recommended = useQuery({...recommendedSummaryModelQuery, enabled: provider === 'builtin-ai'})
    const builtIn = useQuery({...builtInModelsQuery, enabled: provider === 'builtin-ai'})
    const model = draft.models[provider || 'builtin-ai'] ?? (provider === 'builtin-ai' ? recommended.data : undefined)
    const builtInEntry = builtIn.data?.find(({name}) => name === model)
    const builtInReady = builtInEntry !== undefined && modelState(builtInEntry.status).kind === 'ready'

    const chooseModel = (next: string) => provider && change({models: {...draft.models, [provider]: next}})
    const withModel = {...draft, models: {...draft.models, ...(provider && model ? {[provider]: model} : {})}}
    const choice = choiceOf(withModel, {
        apiKey,
        builtInReady,
        whisperModel: config?.whisperModel || WHISPER_MODEL_DEFAULT,
    })

    const save = useMutation({
        ...saveSummaryModelMutation,
        onSuccess: (_reply, {choice: saved}) => {
            // The model of each provider, so switching back finds it again.
            setModelMap({...modelMap, [saved.provider]: saved.model})
            back()
        },
        onError: (error) => toast.error('Couldn’t save the summary model', {description: errorMessage(error)}),
    })

    return (
        <>
            <SubpageScroll>
                <SubpageGroups>
                    <SettingsRadioGroup<SummaryProvider>
                        title="Provider"
                        value={provider || undefined}
                        onValueChange={(next) => change({provider: next})}
                    >
                        {PROVIDER_ORDER.map((id) => (
                            <SettingsRadioRow key={id} value={id} label={SUMMARY_PROVIDERS[id].label} description={SUMMARY_PROVIDERS[id].description}/>
                        ))}
                    </SettingsRadioGroup>
                    {provider === 'builtin-ai' && <BuiltInModelsGroup model={model} onChoose={chooseModel}/>}
                    {cloud && (
                        <CloudGroup
                            key={cloud}
                            provider={cloud}
                            apiKey={apiKey}
                            onApiKey={(key) => change({apiKeys: {...draft.apiKeys, [cloud]: key}})}
                            model={model}
                            onModel={chooseModel}
                            maxLength={draft.maxLength}
                            onMaxLength={(maxLength) => change({maxLength})}
                        />
                    )}
                    {provider === 'ollama' && (
                        <OllamaGroup
                            endpoint={draft.ollamaEndpoint}
                            onEndpoint={(ollamaEndpoint) => change({ollamaEndpoint})}
                            fetched={draft.ollamaFetched}
                            onFetch={() => change({ollamaFetched: draft.ollamaEndpoint})}
                            model={model}
                            onModel={chooseModel}
                        />
                    )}
                    {provider === 'custom-openai' && (
                        <CustomServerGroup fields={draft.custom} onChange={(fields) => change({custom: {...draft.custom, ...fields}})}/>
                    )}
                </SubpageGroups>
            </SubpageScroll>
            <SubpageFooter>
                <Button variant="ghost" onClick={back}>Cancel</Button>
                <Button variant="filled" disabled={!choice} pending={save.isPending} onClick={() => choice && save.mutate(choice)}>
                    Save
                </Button>
            </SubpageFooter>
        </>
    )
}

/**
 * Settings › AI › Summary model: the provider and its model, a cloud
 * provider's key, Ollama's server, a custom server. Nothing is stored until
 * Save, which goes back; Cancel goes back without it.
 */
export function SummaryModelPage({back}: SubpageProps) {
    const config = useQuery(summaryModelQuery)
    const customServer = useQuery(customServerQuery)
    if (config.isError || customServer.isError) {
        return (
            <SubpageScroll>
                <SubpageGroups><Warning>Couldn’t read the summary model: {errorMessage(config.error ?? customServer.error)}</Warning></SubpageGroups>
            </SubpageScroll>
        )
    }
    if (!config.isSuccess || !customServer.isSuccess) return <SubpageScroll><SubpageGroups><Spinner delayed/></SubpageGroups></SubpageScroll>
    return <SummaryModelForm config={config.data} customServer={customServer.data} back={back}/>
}
