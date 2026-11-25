import styled from 'styled-components'
import {CLOUD_PROVIDERS, type CloudProvider, isCloudProvider, SUMMARY_PROVIDERS} from '@/api/summaryProviders'
import {CloudGroup} from '@/components/summaryModel/CloudGroup'
import {Select} from '@/components/ui/Select'
import {SettingsGroup, SettingsRadioGroup, SettingsRadioRow, SettingsRow} from '@/components/ui/SettingsRow'
import {formatModelSize} from '@/lib/sizes'
import type {SummaryChoiceState, SummaryWay} from '../hooks/useSummaryChoice'
import {DownloadList} from './DownloadList'

const Groups = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[4]};
    margin-top: ${({theme}) => theme.space[4]};
`

const PROVIDER_OPTIONS = CLOUD_PROVIDERS.map((id) => ({value: id, label: SUMMARY_PROVIDERS[id].label}))

// "Claude, OpenAI, Groq, or OpenRouter".
const PROVIDER_NAMES = new Intl.ListFormat('en', {type: 'disjunction'}).format(PROVIDER_OPTIONS.map(({label}) => label))

/**
 * How summaries are written, chosen on first launch: the recommended
 * built-in model, installed only on Install; a provider with the user's own
 * key and a model from its list (the cloud group Settings uses); or later.
 */
export function SummaryChoice({choice}: {choice: SummaryChoiceState}) {
    const {way, setWay, builtIn, draft, change, cloud, apiKey} = choice
    const size = builtIn?.state.kind === 'ready' ? 'Installed' : formatModelSize(builtIn?.download.optional?.sizeBytes)
    return (
        <Groups>
            <SettingsRadioGroup<SummaryWay> title="Summaries" value={way} onValueChange={setWay}>
                <SettingsRadioRow value="builtIn" label="On this computer" description={size ? `Built-in model · ${size}` : 'Built-in model'}/>
                <SettingsRadioRow value="provider" label="With your API key" description={PROVIDER_NAMES}/>
                <SettingsRadioRow value="later" label="Later" description="No model is chosen now"/>
            </SettingsRadioGroup>
            {way === 'builtIn' && builtIn && <DownloadList label="Summary model" rows={[builtIn]}/>}
            {way === 'provider' && (
                <SettingsGroup>
                    <SettingsRow
                        label="Provider"
                        control={(
                            <Select<CloudProvider>
                                options={PROVIDER_OPTIONS}
                                value={isCloudProvider(draft.provider) ? draft.provider : undefined}
                                placeholder="Choose a provider"
                                onValueChange={(provider) => change({provider})}
                            />
                        )}
                    />
                </SettingsGroup>
            )}
            {way === 'provider' && cloud && (
                <CloudGroup
                    key={cloud}
                    provider={cloud}
                    apiKey={apiKey}
                    onApiKey={(key) => change({apiKeys: {...draft.apiKeys, [cloud]: key}})}
                    model={draft.models[cloud]}
                    onModel={(model) => change({models: {...draft.models, [cloud]: model}})}
                />
            )}
        </Groups>
    )
}
