import {useEffect, useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {Select} from '@/components/ui/Select'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {TextField} from '@/components/ui/TextField'
import {
    claudeOutputMaximum,
    type CloudProvider,
    parseSummaryLength,
    providerModelsQuery,
} from '../../api/summaryProviders'
import {SUMMARY_PROVIDERS} from '../summaryModel'
import {Warning} from '../styles'
import {NarrowField} from './styles'

/** A key typed stops asking the provider for its models on every keystroke. */
const KEY_SETTLE_MS = 500

function useSettled(value: string) {
    const [settled, setSettled] = useState(value)
    useEffect(() => {
        const timer = setTimeout(() => setSettled(value), KEY_SETTLE_MS)
        return () => clearTimeout(timer)
    }, [value])
    return settled
}

interface CloudGroupProps {
    provider: CloudProvider
    apiKey: string
    onApiKey: (key: string) => void
    model: string | undefined
    onModel: (model: string) => void
    /** Claude only: the maximum summary length as typed. */
    maxLength: string
    onMaxLength: (length: string) => void
}

/**
 * A cloud provider: its key, a model from its list, and for Claude the
 * maximum summary length, checked against the model's own limit as native
 * checks it on Save.
 */
export function CloudGroup({provider, apiKey, onApiKey, model, onModel, maxLength, onMaxLength}: CloudGroupProps) {
    const {label} = SUMMARY_PROVIDERS[provider]
    const key = useSettled(apiKey.trim())
    const models = useQuery(providerModelsQuery(provider, key || null))
    const options = (models.data ?? []).map(({id, label: name}) => ({value: id, label: name}))
    // A saved model the list no longer has stays choosable.
    if (model && !options.some(({value}) => value === model)) options.unshift({value: model, label: model})

    const maximum = provider === 'claude' && model ? claudeOutputMaximum(model) : undefined
    const lengthValid = maximum === undefined || parseSummaryLength(maxLength, maximum) !== undefined

    return (
        <SettingsGroup title={label} note={`Meetings you summarize are sent to ${label}.`}>
            <SettingsRow label="API key">
                <TextField
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste your key"
                    value={apiKey}
                    onChange={(event) => onApiKey(event.target.value)}
                />
            </SettingsRow>
            <SettingsRow
                label="Model"
                description={models.isError ? `Couldn’t list the models: ${errorMessage(models.error)}` : undefined}
                control={(
                    <Select
                        options={options}
                        value={model || undefined}
                        placeholder={models.isPending ? 'Loading models…' : 'Choose a model'}
                        disabled={options.length === 0}
                        onValueChange={onModel}
                    />
                )}
            />
            {provider === 'claude' && (
                <SettingsRow
                    label="Maximum summary length"
                    description={lengthValid
                        ? 'Optional. Empty uses the model’s default'
                        : <Warning as="span">Maximum summary length must be a whole number between 1 and {maximum}, or left empty.</Warning>}
                    control={(
                        <NarrowField>
                            <TextField
                                size="sm"
                                inputMode="numeric"
                                placeholder="tokens"
                                value={maxLength}
                                aria-invalid={!lengthValid}
                                onChange={(event) => onMaxLength(event.target.value)}
                            />
                        </NarrowField>
                    )}
                />
            )}
        </SettingsGroup>
    )
}
