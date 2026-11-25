import {claudeOutputMaximum} from '@/api/summaryProviders'
import {parseNumber} from '@/components/summaryModel/draft'
import {SettingsRow} from '@/components/ui/SettingsRow'
import {TextField} from '@/components/ui/TextField'
import {Warning} from '../styles'
import {NarrowField} from './styles'

interface ClaudeLengthRowProps {
    /** The chosen Claude model; its own limit bounds the length. */
    model: string | undefined
    /** The maximum summary length as typed; empty for the model's default. */
    value: string
    onChange: (length: string) => void
}

/** Claude's maximum summary length, checked against the model's own limit as native checks it on Save. */
export function ClaudeLengthRow({model, value, onChange}: ClaudeLengthRowProps) {
    const maximum = model ? claudeOutputMaximum(model) : undefined
    const valid = maximum === undefined || parseNumber(value, 1, maximum, {whole: true}) !== undefined
    return (
        <SettingsRow
            label="Maximum summary length"
            description={valid
                ? 'Optional. Empty uses the model’s default'
                : <Warning as="span">Maximum summary length must be a whole number between 1 and {maximum}, or left empty.</Warning>}
            control={(
                <NarrowField>
                    <TextField
                        size="sm"
                        inputMode="numeric"
                        placeholder="tokens"
                        value={value}
                        aria-invalid={!valid}
                        onChange={(event) => onChange(event.target.value)}
                    />
                </NarrowField>
            )}
        />
    )
}
