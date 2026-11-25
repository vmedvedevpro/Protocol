import {useEffect, useRef, useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {Select} from '@/components/ui/Select'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {Spinner} from '@/components/ui/Spinner'
import {TextField} from '@/components/ui/TextField'
import {claudeOutputMaximum, type CloudProvider, providerModelsQuery} from '../../api/summaryProviders'
import {useDebouncedSave} from '../../hooks/useDebouncedSave'
import {SUMMARY_PROVIDERS} from '../summaryModel'
import {Warning} from '../styles'
import {parseNumber, TYPING_SETTLE_MS} from './draft'
import {NarrowField} from './styles'

/** The spinner's place in the key field, kept while it is idle. */
const Settling = styled.span`
    display: inline-flex;
    flex: none;
    width: 12px;
    color: ${({theme}) => theme.colors.muted};
`

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
    // The list is asked with the key once typing it has rested; the key is
    // no part of the query's key, so a new one asks again by refetching.
    const [key, setKey] = useState(apiKey.trim())
    const typing = useDebouncedSave(setKey, TYPING_SETTLE_MS)
    const models = useQuery(providerModelsQuery(provider, key || null))
    const asked = useRef(key)
    useEffect(() => {
        if (asked.current === key) return
        asked.current = key
        void models.refetch()
    }, [key, models])
    const options = (models.data ?? []).map(({id, label: name}) => ({value: id, label: name}))
    // A saved model the list no longer has stays choosable.
    if (model && !options.some(({value}) => value === model)) options.unshift({value: model, label: model})

    const maximum = provider === 'claude' && model ? claudeOutputMaximum(model) : undefined
    const lengthValid = maximum === undefined || parseNumber(maxLength, 1, maximum, {whole: true}) !== undefined

    return (
        <SettingsGroup title={label} note={`Meetings you summarize are sent to ${label}.`}>
            <SettingsRow label="API key">
                <TextField
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste your key"
                    value={apiKey}
                    // Always there: a field that gains a trailing element remounts its input and loses focus.
                    trailing={<Settling aria-hidden>{(typing.draft !== null || models.isFetching) && <Spinner size="12px"/>}</Settling>}
                    onChange={(event) => {
                        onApiKey(event.target.value)
                        typing.change(event.target.value.trim())
                    }}
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
