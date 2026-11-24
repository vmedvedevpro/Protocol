import {SettingsGroup, SettingsNavRow} from '@/components/ui/SettingsRow'
import {useAdvancedSettingsStore} from '../store/advanced'
import {
    AutoSummaryRow,
    DeviceRow,
    MeetingLanguageRow,
    NameRow,
    SummaryLanguageRow,
    SummaryModelRow,
    ThemeRow,
} from './PreferenceRows'

/**
 * What most people need, on one page; the rest waits behind the Advanced
 * switch. Its rows are the sections' own, so a change shows in both views.
 */
export function SimpleSettings() {
    const setAdvanced = useAdvancedSettingsStore((state) => state.setAdvanced)
    return (
        <>
            <SettingsGroup title="You">
                <NameRow/>
                <ThemeRow/>
            </SettingsGroup>
            <SettingsGroup title="Recording">
                <DeviceRow type="Input"/>
                <MeetingLanguageRow/>
            </SettingsGroup>
            <SettingsGroup title="Summaries">
                <AutoSummaryRow/>
                <SummaryLanguageRow/>
                <SummaryModelRow/>
            </SettingsGroup>
            <SettingsGroup>
                <SettingsNavRow
                    label="More settings"
                    description="Models, providers, audio tuning, Labs and more"
                    onClick={() => setAdvanced(true)}
                />
            </SettingsGroup>
        </>
    )
}
