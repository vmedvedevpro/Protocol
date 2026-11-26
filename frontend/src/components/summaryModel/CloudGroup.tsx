import {type ReactNode, useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {Button} from '@/components/ui/Button'
import {Select} from '@/components/ui/Select'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {Spinner} from '@/components/ui/Spinner'
import {TextField} from '@/components/ui/TextField'
import {type CloudProvider, isRetryableModelListError, listsWithoutKey, providerModelsQuery, SUMMARY_PROVIDERS} from '@/api/summaryProviders'
import {useDebouncedSave} from '@/lib/useDebouncedSave'
import {TYPING_SETTLE_MS} from './draft'

/** The spinner's place in the key field, kept while it is idle. */
const Settling = styled.span`
    display: inline-flex;
    flex: none;
    width: 12px;
    color: ${({theme}) => theme.colors.muted};
`

const Controls = styled.span`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
`

interface CloudGroupProps {
    provider: CloudProvider
    apiKey: string
    onApiKey: (key: string) => void
    model: string | undefined
    onModel: (model: string) => void
    /** Rows after the model's: Settings' maximum summary length for Claude. */
    children?: ReactNode
}

/**
 * A cloud provider: its key and a model from its list, in Settings ›
 * Summary model and on first launch. The key stays in the caller's draft
 * until it saves the choice (`saveSummaryModelMutation`), which keeps it in
 * native storage; the models query holds only its fingerprint.
 *
 * The select lists only what the provider answered for the key: without a
 * key it stays empty and disabled (OpenRouter's public catalog aside), and a
 * failed listing says why in the row (`ModelListError`).
 */
export function CloudGroup({provider, apiKey, onApiKey, model, onModel, children}: CloudGroupProps) {
    const {label} = SUMMARY_PROVIDERS[provider]
    // The list is asked with the key once typing it has rested; each key
    // has its own query, so a new key starts pending, never with another's list.
    const [key, setKey] = useState(apiKey.trim())
    const typing = useDebouncedSave(setKey, TYPING_SETTLE_MS)
    const models = useQuery(providerModelsQuery(provider, key || null))
    const asks = listsWithoutKey(provider) || key !== ''
    const options = (models.data ?? []).map(({id, label: name}) => ({value: id, label: name}))
    // A saved model the list no longer has stays choosable, once a list is asked for.
    if (asks && model && !options.some(({value}) => value === model)) options.unshift({value: model, label: model})

    let placeholder = 'Choose a model'
    if (!asks) placeholder = 'Paste a key first'
    else if (models.isPending) placeholder = 'Loading models…'
    else if (models.isError) placeholder = 'No models'
    let description: string | undefined
    if (asks && models.isError) description = errorMessage(models.error)
    else if (asks && models.isSuccess && models.data.length === 0) description = `${label} lists no models for this key.`
    // Not reached or a bad answer: the same key may work in a moment. A rejected key is fixed in the field.
    const retry = asks && models.isError && isRetryableModelListError(models.error)

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
                description={description}
                control={(
                    <Controls>
                        {retry && (
                            <Button size="sm" variant="ghost" pending={models.isFetching} onClick={() => void models.refetch()}>
                                Try again
                            </Button>
                        )}
                        <Select
                            options={options}
                            value={asks ? model || undefined : undefined}
                            placeholder={placeholder}
                            pending={asks && models.isPending}
                            disabled={!asks || options.length === 0}
                            onValueChange={onModel}
                        />
                    </Controls>
                )}
            />
            {children}
        </SettingsGroup>
    )
}
