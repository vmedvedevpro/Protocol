import styled from 'styled-components'
import {Select} from '@/components/ui/Select'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {MEETING_LANGUAGES} from '@/lib/languages'

// Apart from the downloads above it, as the summary groups below are.
const Spaced = styled.div`
    margin-top: ${({theme}) => theme.space[4]};
`

const OPTIONS = MEETING_LANGUAGES.map(({code, label}) => ({value: code, label}))

interface MeetingLanguageChoiceProps {
    value: string
    onChange: (language: string) => void
}

/**
 * The meeting language on first launch, from the list Settings offers
 * (`MeetingLanguageRow`); Done saves it to the same store, which sends it to
 * native. Whisper's pass after the meeting is told it, so a meeting that
 * opens with English terms is not misjudged; Parakeet detects the language.
 */
export function MeetingLanguageChoice({value, onChange}: MeetingLanguageChoiceProps) {
    // A stored code the list no longer has stays shown, as in Settings.
    const options = OPTIONS.some((option) => option.value === value) ? OPTIONS : [...OPTIONS, {value, label: value}]
    return (
        <Spaced>
            <SettingsGroup>
                <SettingsRow
                    label="Meeting language"
                    description="The language people speak in meetings"
                    control={<Select options={options} value={value} onValueChange={onChange}/>}
                />
            </SettingsGroup>
        </Spaced>
    )
}
