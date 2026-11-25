import {useState} from 'react'
import {useMutation} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {Button} from '@/components/ui/Button'
import {Collapse} from '@/components/ui/Collapse'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {TextField} from '@/components/ui/TextField'
import {testCustomServer} from '../../api/summaryProviders'
import {Warning} from '../styles'
import {CUSTOM_LIMITS, parseNumber, type SummaryModelDraft} from './draft'
import {NarrowField} from './styles'

type CustomFields = SummaryModelDraft['custom']

interface CustomServerGroupProps {
    fields: CustomFields
    onChange: (fields: Partial<CustomFields>) => void
}

const NUMBERS = [
    {field: 'maxTokens', label: 'Max tokens', hint: 'Optional', limits: CUSTOM_LIMITS.maxTokens},
    {field: 'temperature', label: 'Temperature', hint: 'Optional, 0 to 2', limits: CUSTOM_LIMITS.temperature},
    {field: 'topP', label: 'Top P', hint: 'Optional, 0 to 1', limits: CUSTOM_LIMITS.topP},
] as const

/**
 * An OpenAI-compatible server of the user's: its endpoint, model and key,
 * the sampling options behind "Advanced options", and a test that asks it
 * for one short answer.
 */
export function CustomServerGroup({fields, onChange}: CustomServerGroupProps) {
    const [advanced, setAdvanced] = useState(false)
    const test = useMutation({
        mutationFn: () => testCustomServer({
            endpoint: fields.endpoint.trim(),
            apiKey: fields.apiKey.trim() || null,
            model: fields.model.trim(),
        }),
    })
    const endpointValid = !fields.endpoint.trim() || /^https?:\/\//.test(fields.endpoint.trim())
    const canTest = /^https?:\/\//.test(fields.endpoint.trim()) && fields.model.trim() !== ''

    const field = (name: keyof CustomFields, placeholder: string, type = 'text') => (
        <TextField
            type={type}
            spellCheck={false}
            autoComplete="off"
            placeholder={placeholder}
            value={fields[name]}
            onChange={(event) => {
                test.reset()
                onChange({[name]: event.target.value})
            }}
        />
    )

    return (
        <SettingsGroup title="Server">
            <SettingsRow
                label="Endpoint URL"
                description={endpointValid ? undefined : <Warning as="span">The endpoint starts with http:// or https://</Warning>}
            >
                {field('endpoint', 'http://localhost:8000/v1')}
            </SettingsRow>
            <SettingsRow label="Model name">{field('model', 'Model name')}</SettingsRow>
            <SettingsRow label="API key" description="Optional">{field('apiKey', '', 'password')}</SettingsRow>
            <SettingsRow
                label="Advanced options"
                control={(
                    <Button size="sm" variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
                        {advanced ? 'Hide' : 'Show'}
                    </Button>
                )}
            />
            {/* One Collapse a row: the card draws its hairlines between its own children. */}
            {NUMBERS.map(({field: name, label, hint, limits}) => {
                const valid = parseNumber(fields[name], limits.min, limits.max, {whole: 'whole' in limits}) !== undefined
                return (
                    <Collapse key={name} open={advanced}>
                        <SettingsRow
                            label={label}
                            description={valid ? hint : <Warning as="span">{hint}: this is not a number in range</Warning>}
                            control={<NarrowField>{field(name, '')}</NarrowField>}
                        />
                    </Collapse>
                )
            })}
            <SettingsRow
                label="Test connection"
                description={test.isSuccess
                    ? test.data.message
                    : test.isError ? <Warning as="span">{errorMessage(test.error)}</Warning> : 'Asks the server for one short answer'}
                control={<Button size="sm" disabled={!canTest} pending={test.isPending} onClick={() => test.mutate()}>Test</Button>}
            />
        </SettingsGroup>
    )
}
